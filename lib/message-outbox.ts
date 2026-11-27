// The web server's leg of the message outbox (docs/specs/2026-11-04-message-outbox-design.md, O2 to O4 and O6): a
// message sent to an existing session is stored here before `outbox_add` answers, then sent to pi by one dispatcher
// per session, oldest first and one at a time, and leaves once pi has it. The `session` channel shows the entries.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "path";
import { Database } from "bun:sqlite";
import { commandErrorResponse, runAgentCommand } from "./agent-command";
import { apiErrorResponse, resolveSessionHostOr404 } from "./api-utils";
import { getHost, listHosts, onHostHello, onHostSessionsChanged } from "./hosts/hub";
import { isLinkUp } from "./hosts/host";
import { HostOpError } from "./hosts/link-protocol";
import { STAGED_MAX_AGE_MS } from "./hosts/uploads";
import { validateAgentImages, MAX_AGENT_COMMAND_REQUEST_BYTES, MAX_ATTACHED_IMAGE_BYTES, MAX_TOTAL_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, getBase64DecodedByteLength } from "./image-attachments";
import { listArchivedSessions } from "./pi/archive";
import { OUTBOX_CHANGE_SCHEMA, OUTBOX_SCHEMA } from "./message-outbox-schema";
import { parseMessageOrigin, type MessageOrigin } from "./message-origin";
import { getAgentDir } from "./pi/paths";
import { getRpcSession, getRpcSessionKeys, nativeWriteStarted, tapSessionFrames, type AgentEvent, type AgentSessionWrapper } from "./rpc-manager";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { sessionHostKey, splitSessionHostKey } from "./session-host-key";
import { isRecord } from "./type-guards";
import type { OutboxEntry, OutboxMode } from "./types";
import { MAX_UPLOADS_PER_MESSAGE, UPLOAD_ID_RE } from "./upload-limits";
import { snapshotOutboxUploads, UploadError, type OutboxUploadReceipt } from "./uploads";
import { resolveWebAuthSecret } from "./web-auth-secret";
import { readAgentToolsEnabledFromDisk } from "./web-settings";

/** Delivered (and removed) ids answer a repeated `outbox_add` this long (spec O2: idempotent by id); the browser gives
 * up resending after 7 days, so a resend always finds its id. */
export const KEEP_DELIVERED_MS = 8 * 24 * 60 * 60 * 1000;
/** A session that was busy (restarting, an MCP or history edit) or a host op that timed out: tried again after this. */
export const RETRY_MS = 5_000;
/** Fixed snapshot budget; per-entry error margin and frame envelope included. */
export const MAX_OUTBOX_BYTES = 16 * 1024 * 1024;
export const GITHUB_WATCH_OUTBOX_OWNER = "tau:github-watch";
const MAX_GLOBAL_OUTBOX_BYTES = 256 * 1024 * 1024;
const MAX_GLOBAL_OUTBOX_ENTRIES = 1000;

const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The listener key's host for a caller that names none (host ids never are "*"). */
const ANY_HOST = "*";
const MODES: Record<OutboxMode, true> = { prompt: true, followUp: true, steer: true };


const COLUMNS = "id, session_id, mode, message, images, uploads, owner, state, error, may_have_been_sent, created_at, upload_receipts, previous_entry_ids, source_session_id, settlement, replacement_id, replacement_digest, payload_bytes, origin, host_id";
const RECEIPT_PIN_SCHEMA = "CREATE TABLE IF NOT EXISTS github_receipt_pins (session_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY (entry_id, session_id))";

/** `owner`: the web session whose uploads the entry attaches. */
interface Row {
  id: string;
  session_id: string;
  source_session_id: string;
  mode: OutboxMode;
  message: string;
  images: string | null;
  uploads: string | null;
  owner: string;
  upload_receipts: string | null;
  state: OutboxEntry["state"];
  error: string | null;
  may_have_been_sent: number;
  created_at: number;
  previous_entry_ids: string | null;
  settlement: string | null;
  replacement_id: string | null;
  replacement_digest: string | null;
  payload_bytes: number;
  origin: string | null;
  host_id: string;
}
type AddResult =
  | { kind: "full" }
  | { kind: "paused" }
  | { kind: "conflict" }
  | { kind: "existing"; entry: Row; replaces?: string }
  | { kind: "duplicate"; entry: Row; originalSession: string; replaces: string }
  | { kind: "inserted"; entry: Row; replaced: Row | null };

type NotificationProgress = { revision?: string; retryAt: number };
type OutboxState = {
  busy: Set<string>;
  wakes?: Set<string>;
  listeners: Map<string, Set<(entries: OutboxEntry[]) => void>>;
  pendingNotifications: Map<string, number>;
  notifiedRevisions: Map<string, string>;
  listenerProgress: Map<string, WeakMap<(entries: OutboxEntry[]) => void, NotificationProgress>>;
  started: boolean;
  maintenance?: NodeJS.Timeout;
  changes?: NodeJS.Timeout;
  startupRetry?: NodeJS.Timeout;
  retries?: Set<NodeJS.Timeout>;
  detach?: () => void;
  preparing?: Map<string, object>;
};

declare global {
  var __tauOutboxStore: { path: string; db: Database; schema?: string } | undefined;
  var __tauOutbox: OutboxState | undefined;
}

// globalThis, like the rpc-manager registry: survives a `bun --hot` re-evaluation.
function outbox(): NonNullable<typeof globalThis.__tauOutbox> {
  const state = (globalThis.__tauOutbox ??= { busy: new Set(), listeners: new Map(), pendingNotifications: new Map(), notifiedRevisions: new Map(), listenerProgress: new Map(), started: false });
  state.pendingNotifications ??= new Map();
  state.notifiedRevisions ??= new Map();
  state.listenerProgress ??= new Map();
  return state;
}

/** The store for the current agent directory; reopened when PI_CODING_AGENT_DIR changes. */
function db(): Database {
  const dir = join(getAgentDir(), "tau");
  const path = join(dir, "outbox.db");
  const cached = globalThis.__tauOutboxStore;
  // A `bun --hot` reload keeps a connection the previous code migrated: reopen when the migration changed.
  const schema = `${OUTBOX_SCHEMA}${OUTBOX_CHANGE_SCHEMA}${COLUMNS}${RECEIPT_PIN_SCHEMA}`;
  if (cached?.path === path && cached.schema === schema) return cached.db;
  mkdirSync(dir, { recursive: true });
  // Owner-only before SQLite opens it: it holds message texts. SQLite gives its -wal/-shm files the same mode.
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const database = new Database(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    // A fresh WAL switch ignores busy_timeout while another instance holds its exclusive lock (notification-store).
    for (let attempt = 0; ; attempt++) {
      try {
        database.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        if (!isRecord(error) || error.errno !== 5 || attempt >= 250) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    database.exec("PRAGMA synchronous = NORMAL");
    database.transaction(() => {
      database.exec(OUTBOX_SCHEMA);
      database.exec(RECEIPT_PIN_SCHEMA);
      const columns = database.prepare("PRAGMA table_info(entries)").all() as { name: string }[];
      // Pre-alpha: rows from before hosts are this machine's.
      for (const [name, type] of [["host_id", "TEXT NOT NULL DEFAULT 'local'"], ["dispatch_pid", "INTEGER"], ["upload_receipts", "TEXT"], ["payload_bytes", "INTEGER NOT NULL DEFAULT 0"], ["previous_entry_ids", "TEXT"], ["source_session_id", "TEXT"], ["settlement", "TEXT"], ["replacement_id", "TEXT"], ["replacement_digest", "TEXT"], ["origin", "TEXT"]]) {
        if (!columns.some((column) => column.name === name)) database.exec(`ALTER TABLE entries ADD COLUMN ${name} ${type}`);
      }
      database.exec("CREATE INDEX IF NOT EXISTS entries_source_session ON entries (source_session_id, state)");
      database.exec("CREATE INDEX IF NOT EXISTS entries_host_session ON entries (host_id, session_id, state)");
      const uploadColumns = database.prepare("PRAGMA table_info(completed_uploads)").all() as { name: string }[];
      for (const name of ["proof", "scope"]) {
        if (!uploadColumns.some((column) => column.name === name)) database.exec(`ALTER TABLE completed_uploads ADD COLUMN ${name} TEXT`);
      }
      database.exec("UPDATE entries SET source_session_id = session_id WHERE source_session_id IS NULL");
      database.exec(OUTBOX_CHANGE_SCHEMA);
      for (const entry of database.prepare(`SELECT ${COLUMNS} FROM entries WHERE state != 'delivered' AND payload_bytes = 0`).all() as Row[]) {
        database.prepare("UPDATE entries SET payload_bytes = ? WHERE id = ?").run(Buffer.byteLength(JSON.stringify(toEntry(entry))) + 8192, entry.id);
      }
    }).immediate();
  } catch (error) {
    database.close(true);
    throw error;
  }
  cached?.db.close(true);
  globalThis.__tauOutboxStore = { path, db: database, schema };
  return database;
}

/** Pending GitHub batches can replay after the browser's finite receipt-retention window. */
export function pinOutboxReceipt(sessionId: string, entryId: string): void {
  db().prepare("INSERT OR IGNORE INTO github_receipt_pins (session_id, entry_id) VALUES (?, ?)").run(sessionId, entryId);
}

export function releaseOutboxReceipt(entryId: string): void {
  db().prepare("DELETE FROM github_receipt_pins WHERE entry_id = ?").run(entryId);
}

export function listOutboxReceiptPins(): { sessionId: string; entryId: string }[] {
  return db().prepare("SELECT session_id AS sessionId, entry_id AS entryId FROM github_receipt_pins").all() as { sessionId: string; entryId: string }[];
}

/** Closes the cached store. `close(true)` finalizes the statements still alive: without it the file stays open until GC, and Windows keeps it locked. */
export function closeOutboxStore(): void {
  const state = globalThis.__tauOutbox;
  if (state) {
    clearInterval(state.maintenance);
    clearInterval(state.changes);
    clearTimeout(state.startupRetry);
    for (const timer of state.retries ?? []) clearTimeout(timer);
    state.retries?.clear();
    state.detach?.();
    state.detach = undefined;
    state.maintenance = undefined;
    state.changes = undefined;
    state.pendingNotifications?.clear();
    state.notifiedRevisions?.clear();
    state.listenerProgress?.clear();
    state.startupRetry = undefined;
    state.started = false;
  }
  globalThis.__tauOutboxStore?.db.close(true);
  globalThis.__tauOutboxStore = undefined;
}

/** Main-issued completion authority is committed before "done"; replays never renew its original staging lifetime. */
export function saveCompletedUpload(owner: string, receipt: OutboxUploadReceipt): string | undefined {
  const database = db();
  return database.transaction(() => {
    const stored = database.prepare("SELECT owner, receipt, at, proof, scope FROM completed_uploads WHERE id = ?").get(receipt.id) as CompletedUploadRow | null;
    const scope = outboxScope();
    if (stored) {
      const prior = JSON.parse(stored.receipt) as OutboxUploadReceipt;
      if (stored.owner !== owner || prior.hostId !== receipt.hostId || prior.name !== receipt.name || prior.size !== receipt.size || prior.type !== receipt.type) {
        throw new UploadError(409, "upload_id_conflict", "Another upload has this id");
      }
      if (Date.now() - stored.at > STAGED_MAX_AGE_MS) return undefined;
      if (stored.proof) return stored.scope === scope ? stored.proof : undefined;
      const proof = randomBytes(32).toString("base64url");
      database.prepare("UPDATE completed_uploads SET proof = ?, scope = ? WHERE id = ?").run(proof, scope, receipt.id);
      const completionKey = createHash("sha256").update(proof).digest("hex");
      const held = database.prepare("SELECT id, owner, upload_receipts FROM entries WHERE state != 'delivered' AND upload_receipts IS NOT NULL")
        .all() as { id: string; owner: string; upload_receipts: string }[];
      for (const entry of held) {
        const receipts = JSON.parse(entry.upload_receipts) as OutboxUploadReceipt[];
        let changed = false;
        for (const saved of receipts) {
          if (saved.id !== receipt.id || (saved.owner ?? entry.owner) !== owner || saved.completionKey !== undefined
            || (saved.completedAt !== undefined && saved.completedAt !== stored.at)
            || saved.hostId !== prior.hostId || saved.name !== prior.name || saved.size !== prior.size || saved.type !== prior.type) continue;
          saved.completionKey = completionKey;
          saved.completedAt = stored.at;
          changed = true;
        }
        if (changed) {
          const encoded = JSON.stringify(receipts);
          database.prepare("UPDATE entries SET upload_receipts = ?, payload_bytes = payload_bytes + ? WHERE id = ?")
            .run(encoded, Buffer.byteLength(encoded) - Buffer.byteLength(entry.upload_receipts), entry.id);
        }
      }
      return proof;
    }
    const proof = randomBytes(32).toString("base64url");
    database.prepare("INSERT INTO completed_uploads (id, owner, receipt, at, proof, scope) VALUES (?, ?, ?, ?, ?, ?)")
      .run(receipt.id, owner, JSON.stringify(receipt), Date.now(), proof, scope);
    return proof;
  }).immediate();
}

interface CompletedUploadRow { owner: string; receipt: string; at: number; proof: string | null; scope: string | null }

/** Private authority only: never include this result in browser snapshots or native commands. */
export function completedUpload(id: string): { owner: string; receipt: OutboxUploadReceipt; at: number; proof: string | null; scope: string | null } | null {
  const stored = db().prepare("SELECT owner, receipt, at, proof, scope FROM completed_uploads WHERE id = ?").get(id) as CompletedUploadRow | null;
  if (!stored || Date.now() - stored.at > STAGED_MAX_AGE_MS) return null;
  return { ...stored, receipt: JSON.parse(stored.receipt) as OutboxUploadReceipt };
}

export function forgetCompletedUpload(id: string, expected?: Pick<CompletedUploadRow, "owner" | "at" | "proof">): void {
  if (expected) {
    db().prepare("DELETE FROM completed_uploads WHERE id = ? AND owner = ? AND at = ? AND proof IS ?")
      .run(id, expected.owner, expected.at, expected.proof);
  } else db().prepare("DELETE FROM completed_uploads WHERE id = ?").run(id);
}

/** Accepted authority reserves an id even if its staging registration was canceled or consumed. */
export function outboxUsesUpload(id: string): boolean {
  return db().prepare("SELECT 1 FROM entries, json_each(entries.uploads) AS upload WHERE entries.state != 'delivered' AND upload.value = ? LIMIT 1").get(id) !== null;
}

function row(id: string): Row | null {
  return db().prepare(`SELECT ${COLUMNS} FROM entries WHERE id = ?`).get(id) as Row | null;
}

function storedOrigin(value: string | null): MessageOrigin | undefined {
  if (!value) return undefined;
  try {
    return parseMessageOrigin(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

function toEntry(entry: Row): OutboxEntry {
  const origin = storedOrigin(entry.origin);
  return {
    id: entry.id,
    sessionId: entry.session_id,
    hostId: entry.host_id,
    mode: entry.mode,
    message: entry.message,
    ...(entry.images ? { images: JSON.parse(entry.images) as OutboxEntry["images"] } : {}),
    ...(entry.uploads ? { uploads: JSON.parse(entry.uploads) as string[] } : {}),
    ...(origin ? { origin } : {}),
    state: entry.state,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.may_have_been_sent ? { mayHaveBeenSent: true } : {}),
    ...(entry.state === "delivering" && entry.previous_entry_ids ? { previousEntryIds: JSON.parse(entry.previous_entry_ids) as string[] } : {}),
    ...(entry.state === "delivered" ? {
      settlement: entry.settlement === "native" || entry.settlement === "none" ? entry.settlement : "uncorrelated" as const,
    } : {}),
    createdAt: entry.created_at,
  };
}

/** A session's entries not delivered yet, in submission order. An unreadable store must fail explicitly, not tell a
 * browser that its held messages have vanished. */
export function outboxEntries(sessionId: string, hostId?: string | null): OutboxEntry[] {
  const scope = hostId || null;
  const keys = sessionKeys(sessionId, scope);
  const rows = db().prepare(`SELECT ${COLUMNS} FROM entries WHERE ${entrySessionMatch(keys)} AND state != 'delivered' ORDER BY rowid`).all(...matchArgs(scope, keys)) as Row[];
  return rows.map((entry) => ({ ...toEntry(entry), sessionId, ...(scope ? { hostId: scope } : {}) }));
}

/** The sessions that own these ids' rows now. A native identity move re-homes a row while its browser still asks under the old id. */
export function outboxCanonicalSessions(ids: readonly string[], hostId?: string | null): string[] {
  const rows = db().prepare(`SELECT DISTINCT session_id FROM entries WHERE id IN (${slots(ids)})${hostId ? " AND host_id = ?" : ""}`).all(...ids, ...(hostId ? [hostId] : [])) as { session_id: string }[];
  return rows.map((row) => row.session_id);
}

/** Recent tombstones let a browser retire its first-leg bridge even if it subscribes after the message was delivered. */
export function outboxSettlements(sessionId: string, hostId?: string | null): {
  settledIds: string[]; nativeSettledIds?: string[];
} {
  const scope = hostId || null;
  const keys = sessionKeys(sessionId, scope);
  const cutoff = Date.now() - KEEP_DELIVERED_MS;
  // Read both bounded windows and their dispositions in one SQLite snapshot.
  const receipts = db().prepare(`
    WITH current_receipts AS (
      SELECT id, settlement FROM entries WHERE (? IS NULL OR host_id = ?) AND session_id IN (${slots(keys)})
        AND state = 'delivered' AND done_at >= ? ORDER BY done_at DESC, rowid DESC LIMIT 256
    ), moved_receipts AS (
      SELECT id, settlement FROM entries WHERE ${entrySessionMatch(keys)}
        AND session_id NOT IN (${slots(keys)}) AND state = 'delivered' AND done_at >= ?
        ORDER BY done_at DESC, rowid DESC LIMIT 256
    )
    SELECT id, settlement FROM current_receipts UNION ALL SELECT id, settlement FROM moved_receipts
  `).all(scope, scope, ...keys, cutoff, ...matchArgs(scope, keys), ...keys, cutoff) as { id: string; settlement: string | null }[];
  const nativeSettledIds = receipts.filter((entry) => entry.settlement === "native").map((entry) => entry.id);
  return {
    settledIds: receipts.map((entry) => entry.id),
    ...(nativeSettledIds.length ? { nativeSettledIds } : {}),
  };
}

/** A session's entries and settlements read in one SQLite snapshot: a peer server retiring an entry between two separate
 * reads would leave out both the entry and its receipt (or list it as pending and settled at once). */
export function outboxSnapshot(sessionId: string, hostId?: string | null): { entries: OutboxEntry[]; settledIds: string[]; nativeSettledIds?: string[] } {
  return db().transaction(() => ({ entries: outboxEntries(sessionId, hostId), ...outboxSettlements(sessionId, hostId) }))();
}

/** Which copies of a session id a read or match covers: one host's, or null, every host's, for a caller that names none
 * (as before hosts). The dispatcher always passes a row's own host. */
type HostScope = string | null;

/** The ids one host's copy of a session answers to (its native aliases). Another host's copy of the id is another session. */
function sessionKeys(sessionId: string, hostId: HostScope): string[] {
  const wrapper = getRpcSession(sessionId, hostId);
  return [...new Set([sessionId, ...getRpcSessionKeys(sessionId, hostId), ...(wrapper?.sessionId ? [wrapper.sessionId] : [])])];
}
const slots = (keys: readonly string[]) => keys.map(() => "?").join(",");

/** Bound with `matchArgs(scope, keys)`. */
function entrySessionMatch(keys: string[]): string {
  const values = slots(keys);
  return `((? IS NULL OR host_id = ?) AND (session_id IN (${values}) OR source_session_id IN (${values}) OR id IN (SELECT entry_id FROM entry_aliases WHERE session_id IN (${values}))))`;
}
const matchArgs = (scope: HostScope, keys: string[]) => [scope, scope, ...keys, ...keys, ...keys];

function entryBelongsToSession(entry: Row, sessionId: string, hostId: HostScope): boolean {
  const keys = sessionKeys(sessionId, hostId);
  return db().prepare(`SELECT 1 FROM entries WHERE id = ? AND ${entrySessionMatch(keys)}`).get(entry.id, ...matchArgs(hostId, keys)) !== null;
}
function receiptPinCondition(database: Database): string {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'github_receipt_pins'").get()
    ? " AND NOT EXISTS (SELECT 1 FROM github_receipt_pins WHERE entry_id = entries.id)"
    : "";
}

function pruneDelivered(database: Database, cutoff: number): void {
  const pinned = receiptPinCondition(database);
  database.prepare(`DELETE FROM entries WHERE state = 'delivered' AND done_at < ? AND (replacement_id IS NULL OR replacement_digest IS NULL)${pinned}`)
    .run(cutoff);
}

/** Retry mappings are content-free but needed while stale browser copies may replay this session. */
export function forgetSessionReplacementMappings(sessionId: string, hostId: string): void {
  if (!existsSync(join(getAgentDir(), "tau", "outbox.db"))) return;
  const database = db();
  const keys = sessionKeys(sessionId, hostId);
  const pinned = receiptPinCondition(database);
  database.transaction(() => {
    database.prepare(`DELETE FROM entries WHERE ${entrySessionMatch(keys)} AND state = 'delivered'
      AND replacement_id IS NOT NULL AND replacement_digest IS NOT NULL${pinned}`)
      .run(...matchArgs(hostId, keys));
  }).immediate();
}

/** Call `listener` with one host copy's entries after every change. */
export function onOutboxChange(sessionId: string, hostId: string | null | undefined, listener: (entries: OutboxEntry[]) => void): () => void {
  const state = outbox();
  const { listeners } = state;
  const key = sessionHostKey(hostId || ANY_HOST, sessionId);
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(key) === set) {
      listeners.delete(key);
      state.pendingNotifications.delete(key);
      state.notifiedRevisions.delete(key);
      state.listenerProgress.delete(key);
    }
  };
}

function publish(sessionId: string, hostId: string): void {
  const keys = sessionKeys(sessionId, hostId);
  const canonical = getRpcSession(sessionId, hostId)?.sessionId;
  if (canonical && keys.length > 1) {
    // Native identity moves keep old registry keys. Ordinary branch/switch drops them and cannot migrate other rows.
    db().prepare(`UPDATE entries SET session_id = ? WHERE host_id = ? AND session_id IN (${slots(keys)}) AND session_id != ?`).run(canonical, hostId, ...keys, canonical);
  }
  for (const watched of [...outbox().listeners.keys()]) notifyListeners(watched);
}

/** `key`: sessionHostKey(host, id) of a watched copy. */
function notifyListeners(key: string): void {
  const { hostId: host, id: sessionId } = splitSessionHostKey(key);
  const hostId = host === ANY_HOST ? null : host;
  const state = outbox();
  const listeners = state.listeners.get(key);
  if (!listeners?.size) {
    state.pendingNotifications.delete(key);
    state.notifiedRevisions.delete(key);
    state.listenerProgress.delete(key);
    return;
  }
  const now = performance.now();
  if ((state.pendingNotifications.get(key) ?? 0) > now && !state.notifiedRevisions.has(key)) return;
  try {
    const keys = sessionKeys(sessionId, hostId).sort();
    // session_changes is keyed `<host>/<id>`; every host's copy for a caller that names none.
    const changed = hostId === null
      ? db().prepare<{ revision: number }, string[]>(
        `SELECT COALESCE(SUM(revision), 0) AS revision FROM session_changes WHERE substr(session_id, instr(session_id, '/') + 1) IN (${slots(keys)})`,
      ).get(...keys)
      : db().prepare<{ revision: number }, string[]>(
        `SELECT COALESCE(SUM(revision), 0) AS revision FROM session_changes WHERE session_id IN (${slots(keys)})`,
      ).get(...keys.map((id) => sessionHostKey(hostId, id)));
    const revision = `${keys.join("\0")}:${changed?.revision}`;
    if (state.notifiedRevisions.get(key) === revision && (state.pendingNotifications.get(key) ?? Infinity) > now) return;
    let progress = state.listenerProgress.get(key);
    if (!progress) {
      progress = new WeakMap();
      state.listenerProgress.set(key, progress);
    }
    let entries: OutboxEntry[] | undefined;
    let retryAt = Infinity;
    for (const listener of [...listeners]) {
      const previous = progress.get(listener);
      if (previous?.revision === revision) continue;
      if (previous && previous.retryAt > now) { retryAt = Math.min(retryAt, previous.retryAt); continue; }
      entries ??= outboxEntries(sessionId, hostId);
      try {
        listener(entries);
        progress.set(listener, { revision, retryAt: 0 });
      } catch (error) {
        const nextRetry = now + RETRY_MS;
        progress.set(listener, { revision: previous?.revision, retryAt: nextRetry });
        retryAt = Math.min(retryAt, nextRetry);
        console.warn(`[tau] outbox notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    state.notifiedRevisions.set(key, revision);
    if (Number.isFinite(retryAt)) state.pendingNotifications.set(key, retryAt);
    else state.pendingNotifications.delete(key);
  } catch (error) {
    state.notifiedRevisions.delete(key);
    state.pendingNotifications.set(key, now + RETRY_MS);
    console.warn(`[tau] outbox notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One attempt's transition. A claim another live server holds is its delivery (spec O5): never reset or failed here. */
function setState(id: string, state: OutboxEntry["state"], error: string | null = null, mayHaveBeenSent = false): boolean {
  return db().prepare("UPDATE entries SET state = ?, error = ?, may_have_been_sent = ?, previous_entry_ids = CASE WHEN ? = 'delivering' THEN previous_entry_ids ELSE NULL END WHERE id = ? AND (state IN ('held', 'waiting_host') OR (state = 'delivering' AND dispatch_pid = ?))")
    .run(state, error?.slice(0, 1024) ?? null, mayHaveBeenSent ? 1 : 0, state, id, process.pid).changes > 0;
}

/** Delivered, or removed by the user: the id stays (without the message) so a late resend of it (keepalive, Background
 * Sync) is answered instead of added again. */
function retire(id: string, settlement: "native" | "none" | "uncorrelated", replacementId?: string, replacementDigest?: string): void {
  db().prepare("UPDATE entries SET state = 'delivered', message = '', images = NULL, uploads = NULL, upload_receipts = NULL, origin = NULL, previous_entry_ids = NULL, error = NULL, done_at = ?, settlement = ?, replacement_id = COALESCE(?, replacement_id), replacement_digest = COALESCE(?, replacement_digest) WHERE id = ?").run(Date.now(), settlement, replacementId ?? null, replacementDigest ?? null, id);
}

const invalid = (error: string) => Response.json({ error, code: "invalid_outbox_entry" }, { status: 400 });

/** Nonsecret namespace for browser-held sends: stable across cookie renewal, different after installation or
 * credential changes. Never bind an old entry to the new namespace automatically. */
export function outboxScope(): string {
  const secret = resolveWebAuthSecret();
  return createHmac("sha256", Buffer.from(secret.key, "base64url"))
    .update(`tau-outbox-scope-v1\0${secret.salt}\0${(process.env.TAU_PASSWORD_HASH ?? "").trim()}\0${(process.env.TAU_TRUSTED_HEADER_SHA256 ?? "").trim()}`)
    .digest("base64url");
}

function confirmedReplacementId(entry: Row, sessionId: string, hostId: HostScope, value: unknown): string | undefined {
  if (typeof value !== "string" || !ENTRY_ID_RE.test(value)) return undefined;
  const original = row(value);
  if (!original || !entryBelongsToSession(original, sessionId, hostId) || !original.replacement_id) return undefined;
  return original.replacement_id === entry.id || (entry.replacement_id !== null && original.replacement_id === entry.replacement_id)
    ? value : undefined;
}
/** `outbox_add` / `outbox_remove` for `hostId`'s copy of `sessionId`, as runAgentCommand answers them. Without a host,
 * a known entry keeps its own, and a new one takes the host runAgentCommand would reach (the live wrapper's, else the
 * host listing the id), stored on the row: every later step uses that copy only. */
export async function runOutboxCommand(sessionId: string, command: Record<string, unknown>, owner: string, { origin: originValue, hostId }: { origin?: MessageOrigin; hostId?: string | null } = {}): Promise<Response> {
  if (command.origin !== undefined) return Response.json({ error: "Message origin is server-owned.", code: "origin_not_allowed" }, { status: 400 });
  const origin = originValue === undefined ? undefined : parseMessageOrigin(originValue);
  if (originValue !== undefined && !origin) return invalid("origin is invalid");
  if (command.type === "outbox_scope") return Response.json({ success: true, data: { scope: outboxScope() } });
  const scope = outboxScope();
  if (command.type === "outbox_add" && command.scope !== scope) {
    return Response.json({
      error: "This message belongs to another tau installation or sign-in configuration.",
      code: "outbox_scope_changed",
    }, { status: 409 });
  }
  const { id } = command;
  if (typeof id !== "string" || !ENTRY_ID_RE.test(id)) return invalid("id must be 1 to 64 letters, digits, - or _");
  if (command.type === "outbox_remove") return removeEntry(sessionId, hostId, id);

  const known = row(id);
  if (known) {
    if (!entryBelongsToSession(known, sessionId, hostId || known.host_id || null)) return Response.json({ error: "This message id belongs to another session", code: "outbox_id_conflict" }, { status: 409 });
    const replaces = confirmedReplacementId(known, sessionId, hostId || known.host_id || null, command.replaces);
    const entry = toEntry(known);
    return Response.json({ success: true, data: { entry: replaces ? { ...entry, replaces } : entry } });
  }
  const { mode, message, images, uploads, replaces } = command;
  if (replaces !== undefined && (typeof replaces !== "string" || !ENTRY_ID_RE.test(replaces) || replaces === id)) {
    return invalid("replaces must be another entry's id");
  }
  if (typeof mode !== "string" || !Object.hasOwn(MODES, mode)) return invalid("mode must be prompt, followUp or steer");
  if (typeof message !== "string") return invalid("message must be a string");
  if (Buffer.byteLength(JSON.stringify(command)) > MAX_AGENT_COMMAND_REQUEST_BYTES) {
    return Response.json({ error: "Agent command is too large", code: "request_too_large" }, { status: 413 });
  }
  const imageError = validateAgentImages(images);
  if (imageError) {
    const sizes = Array.isArray(images) ? images.map((image) => isRecord(image) && typeof image.data === "string" ? getBase64DecodedByteLength(image.data) ?? 0 : 0) : [];
    const oversized = sizes.length > MAX_ATTACHED_IMAGES || sizes.some((size) => size > MAX_ATTACHED_IMAGE_BYTES) || sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_ATTACHED_IMAGE_BYTES;
    return oversized ? Response.json({ error: imageError, code: "request_too_large" }, { status: 413 }) : invalid(imageError);
  }
  if (uploads !== undefined && (
    !Array.isArray(uploads) || uploads.length > MAX_UPLOADS_PER_MESSAGE || new Set(uploads).size !== uploads.length
    || !uploads.every((upload) => typeof upload === "string" && UPLOAD_ID_RE.test(upload))
  )) {
    return invalid(`uploads must be at most ${MAX_UPLOADS_PER_MESSAGE} upload ids`);
  }
  const imagePayload = Array.isArray(images) && images.length ? JSON.stringify(images) : null;
  const uploadIds = Array.isArray(uploads) ? uploads as string[] : [];
  const uploadPayload = uploadIds.length ? JSON.stringify(uploadIds) : null;
  const digestKey = resolveWebAuthSecret().key;
  const retryDigest = createHmac("sha256", digestKey).update(JSON.stringify([mode, message, imagePayload, uploadPayload])).digest("base64url");
  // Without a host, the owner is resolved once (a live copy first, else the host lists) and stored on the row.
  const resolved = await resolveSessionHostOr404(sessionId, hostId);
  let host = hostId || ("host" in resolved ? resolved.host.id : null);
  // An archived session (on this machine or a linked host) is not gone: its entries wait on the host whose archive
  // lists it until it is restored (spec O6), and so do a named host's whose archive could not be asked about.
  if ("response" in resolved && resolved.response.status === 404) {
    const archive = await archiveState(sessionId, hostId);
    if (archive.state === "archived") host = hostId || archive.hostId || null;
    else if (archive.state === "absent") {
      // A restore can move the session from archive to active between these independent reads. Only a fresh active
      // lookup may confirm deletion.
      const current = await resolveSessionHostOr404(sessionId, hostId);
      if ("response" in current && current.response.status === 404) return current.response;
      if ("host" in current) host = current.host.id;
    }
  }
  // No host can be named (its list is unavailable): never stored and never guessed as this machine. The retryable
  // answer leaves the browser its copy, which it sends again.
  if (!host) {
    return "response" in resolved && resolved.response.status !== 404 ? resolved.response
      : Response.json({ error: "The session's host cannot be determined yet", code: "host_sessions_unavailable" }, { status: 503 });
  }

  const now = Date.now();
  const database = db();
  const hostScope = host;
  const keys = sessionKeys(sessionId, hostScope);
  let result: AddResult;
  try {
    result = database.transaction((): AddResult => {
      // Inside the add's own write lock: a separate autocommit DELETE took the lock a second time per add, and failing
      // to get it (busy past busy_timeout with several servers adding at once) failed the whole add with a 500.
      pruneDelivered(database, now - KEEP_DELIVERED_MS);
      const concurrent = row(id);
      if (concurrent) {
        if (!entryBelongsToSession(concurrent, sessionId, hostScope)) return { kind: "conflict" };
        const confirmsReplacement = confirmedReplacementId(concurrent, sessionId, hostScope, replaces);
        return { kind: "existing", entry: concurrent, ...(confirmsReplacement ? { replaces: confirmsReplacement } : {}) };
      }
      // Host discovery may have awaited while another server disabled the watcher.
      if (owner === GITHUB_WATCH_OUTBOX_OWNER && !readAgentToolsEnabledFromDisk()) return { kind: "paused" };
      const original = typeof replaces === "string" ? row(replaces) : null;
      // Lineage is per host copy: another host's entry of the same id is never retired or copied here.
      const originalMatchesSession = original !== null && entryBelongsToSession(original, sessionId, hostScope);
      if (original && originalMatchesSession && original.replacement_id) {
        if (original.replacement_digest !== retryDigest) {
          throw new UploadError(409, "outbox_replacement_conflict", "A retry must keep its original mode, message and attachments");
        }
        const settledAt = Date.now();
        database.prepare("UPDATE entries SET done_at = ? WHERE id = ? AND replacement_id = ?").run(settledAt, original.id, original.replacement_id);
        // Persist a matching-ID terminal receipt so this browser can replay after a lost acknowledgement.
        database.prepare(`INSERT INTO entries (${COLUMNS}, done_at) VALUES (?, ?, ?, '', NULL, NULL, ?, 'delivered', NULL, 0, ?, NULL, NULL, ?, 'none', ?, NULL, 0, NULL, ?, ?)`)
          .run(id, original.session_id, original.mode, original.owner, settledAt, original.source_session_id, original.replacement_id, original.host_id, settledAt);
        const entry = row(id);
        if (!entry) throw new Error("The replacement receipt could not be read after commit");
        return { kind: "duplicate", entry, originalSession: original.session_id, replaces: original.id };
      }
      if (original && originalMatchesSession && original.state !== "failed" && original.state !== "delivered") {
        throw new UploadError(409, "outbox_original_pending", "The original message is still waiting or being delivered. Check the outbox before retrying.");
      }
      const replaceable = original && original.state === "failed" && originalMatchesSession ? original : null;
      const matchesOriginal = replaceable !== null
        && createHmac("sha256", digestKey).update(JSON.stringify([replaceable.mode, replaceable.message, replaceable.images, replaceable.uploads])).digest("base64url") === retryDigest;
      let uploadReceipts: OutboxUploadReceipt[];
      let entryOwner = owner;
      if (replaceable && matchesOriginal && uploadIds.length > 0 && owner !== replaceable.owner && command.uploadProofs === undefined) {
        const receipts = replaceable.upload_receipts ? JSON.parse(replaceable.upload_receipts) as OutboxUploadReceipt[] : [];
        const checkedAt = Date.now();
        const validReceipts = checkedAt - replaceable.created_at <= STAGED_MAX_AGE_MS
          && receipts.length === uploadIds.length
          && receipts.every((receipt, index) => {
            if (receipt.id !== uploadIds[index] || (receipt.owner ?? replaceable.owner) !== replaceable.owner) return false;
            const stored = completedUpload(receipt.id);
            if (!stored) return false;
            return stored.owner === replaceable.owner && stored.scope === scope
              && (receipt.completedAt === undefined || receipt.completedAt === stored.at)
              && stored.receipt.hostId === receipt.hostId && stored.receipt.name === receipt.name
              && stored.receipt.size === receipt.size && stored.receipt.type === receipt.type
              && (stored.proof ? createHash("sha256").update(stored.proof).digest("hex") : undefined) === receipt.completionKey;
          });
        if (!validReceipts) throw new UploadError(404, "upload_missing", "The upload is gone: attach the file again");
        uploadReceipts = receipts;
        entryOwner = replaceable.owner;
      } else uploadReceipts = snapshotOutboxUploads(uploadIds, owner, command.uploadProofs);
      if (replaceable && !matchesOriginal) {
        throw new UploadError(409, "outbox_replacement_conflict", "A retry must keep its original mode, message and attachments");
      }
      const savedUploads = uploadReceipts.length ? JSON.stringify(uploadReceipts) : null;
      const savedOrigin = replaceable ? storedOrigin(replaceable.origin) : origin;
      const savedOriginPayload = savedOrigin ? JSON.stringify(savedOrigin) : null;
      const payloadBytes = Buffer.byteLength(JSON.stringify({
        id, sessionId, mode, message, images, uploads, origin: savedOrigin, state: "waiting_host", createdAt: now,
      })) + 8192 + (savedUploads ? Buffer.byteLength(savedUploads) : 0);
      const replacedBytes = replaceable?.payload_bytes ?? 0;
      const total = database.prepare(`SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM entries WHERE ${entrySessionMatch(keys)} AND state != 'delivered'`).get(...matchArgs(hostScope, keys)) as { bytes: number };
      if (total.bytes - replacedBytes + payloadBytes > MAX_OUTBOX_BYTES - 64 * 1024) return { kind: "full" };
      const global = database.prepare("SELECT COALESCE(SUM(payload_bytes), 0) AS bytes, COUNT(*) AS count FROM entries WHERE state != 'delivered'").get() as { bytes: number; count: number };
      if (global.bytes - replacedBytes + payloadBytes > MAX_GLOBAL_OUTBOX_BYTES
        || global.count - (replaceable ? 1 : 0) >= MAX_GLOBAL_OUTBOX_ENTRIES) return { kind: "full" };
      database.prepare(`INSERT INTO entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', NULL, 0, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?)`).run(
        id, sessionId, mode, message,
        imagePayload,
        uploadPayload,
        entryOwner, now,
        savedUploads,
        sessionId, retryDigest, payloadBytes, savedOriginPayload, host,
      );
      let retiredRoot = replaceable;
      if (replaceable) retire(replaceable.id, "none", id, retryDigest);
      else if (original && originalMatchesSession && original.state === "delivered") {
        // Explicit retry is a new send, but the old native disposition must stay intact.
        database.prepare("UPDATE entries SET replacement_id = ?, replacement_digest = ?, done_at = ? WHERE id = ?")
          .run(id, retryDigest, now, original.id);
        retiredRoot = original;
      } else if (!original && typeof replaces === "string") {
        // A browser-only root needs the same durable identity even when this copy's acknowledgement is lost.
        database.prepare(`INSERT INTO entries (${COLUMNS}, done_at) VALUES (?, ?, ?, '', NULL, NULL, ?, 'delivered', NULL, 0, ?, NULL, NULL, ?, 'none', ?, ?, 0, NULL, ?, ?)`)
          .run(replaces, sessionId, mode, entryOwner, now, sessionId, id, retryDigest, host, now);
        retiredRoot = row(replaces);
        if (!retiredRoot) throw new Error("The browser retry mapping could not be read after commit");
      }
      const entry = row(id);
      if (!entry) throw new Error("The accepted outbox entry could not be read after commit");
      return { kind: "inserted", entry, replaced: retiredRoot };
    }).immediate();
  } catch (error) {
    return commandErrorResponse(error);
  }
  if (result.kind === "conflict") return Response.json({ error: "This message id belongs to another session", code: "outbox_id_conflict" }, { status: 409 });
  if (result.kind === "paused") return Response.json({ error: "Agent tools are disabled; GitHub updates are paused.", code: "agent_tools_disabled" }, { status: 503 });
  if (result.kind === "full") return Response.json({ error: "The message outbox is full. It will accept more messages after held entries drain or are deleted.", code: "outbox_full" }, { status: 429 });
  if (result.kind === "existing") {
    const entry = toEntry(result.entry);
    return Response.json({ success: true, data: { entry: result.replaces ? { ...entry, replaces: result.replaces } : entry } });
  }
  if (result.kind === "duplicate") {
    publish(result.originalSession, host);
    if (result.originalSession !== sessionId) publish(sessionId, host);
    return Response.json({ success: true, data: { entry: { ...toEntry(result.entry), replaces: result.replaces } } });
  }
  publish(sessionId, host);
  if (result.replaced && result.replaced.session_id !== sessionId) publish(result.replaced.session_id, host);
  pump(sessionId, host);
  const entry = toEntry(result.entry);
  return Response.json({ success: true, data: { entry: result.replaced ? { ...entry, replaces: result.replaced.id } : entry } });
}

function removeEntry(sessionId: string, hostId: string | null | undefined, id: string): Response {
  let removed: Row | null = null;
  const response = db().transaction(() => {
    const entry = row(id);
    if (!entry || !entryBelongsToSession(entry, sessionId, hostId || entry.host_id || null) || entry.state === "delivered") {
      return Response.json({ success: true, data: { removed: false } });
    }
    if (entry.state === "delivering") {
      return Response.json({ error: "This message is already being delivered.", code: "outbox_dispatched" }, { status: 409 });
    }
    retire(id, "none");
    removed = entry;
    return Response.json({ success: true, data: { removed: true, entry: { ...toEntry(entry), sessionId } } });
  }).immediate();
  if (removed) {
    const { session_id: removedSession, host_id: removedHost } = removed as Row;
    publish(removedSession, removedHost);
    if (removedSession !== sessionId) publish(sessionId, removedHost);
  }
  return response;
}

/** Send the oldest held entry of `hostId`'s copy of the session unless one of its entries is in flight. Another host's
 * copy of the id has its own claim. Never throws. */
export function pumpOutbox(sessionId: string, hostId?: string | null): void {
  const hosts = hostId ? [hostId]
    : (db().prepare("SELECT DISTINCT host_id FROM entries WHERE session_id = ?").all(sessionId) as { host_id: string }[]).map((row) => row.host_id);
  for (const host of hosts) pump(sessionId, host);
}

/** One host copy's queue: `hostId`'s rows of the session, oldest first and one delivering at a time; another host's copy
 * of the id has its own. */
function pump(sessionId: string, hostId: string): void {
  const { busy } = outbox();
  const keys = sessionKeys(sessionId, hostId);
  const busyKeys = keys.map((key) => sessionHostKey(hostId, key));
  if (busyKeys.some((key) => busy.has(key))) return;
  let next: Row | null;
  try {
    for (const key of keys) recoverDelivering(key, hostId);
    if (db().prepare(`SELECT 1 FROM entries WHERE host_id = ? AND session_id IN (${slots(keys)}) AND state = 'delivering'`).get(hostId, ...keys)) return;
    next = db().prepare(`SELECT ${COLUMNS} FROM entries WHERE host_id = ? AND session_id IN (${slots(keys)}) AND state IN ('held', 'waiting_host') ORDER BY rowid LIMIT 1`).get(hostId, ...keys) as Row | null;
  } catch (error) {
    console.warn(`[tau] outbox: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!next) return;
  for (const key of busyKeys) busy.add(key);
  const state = outbox();
  const release = () => {
    for (const key of busyKeys) busy.delete(key);
    for (const key of busyKeys) if (state.wakes?.delete(key)) queueMicrotask(() => {
      if (globalThis.__tauOutbox === state && state.started) pump(splitSessionHostKey(key).id, hostId);
    });
  };
  void deliver(next).then((outcome) => {
    release();
    if (outcome === "next") pump(sessionId, hostId);
    else if (outcome === "offline") {
      const linkedKeys = sessionKeys(sessionId, hostId);
      db().prepare(`UPDATE entries SET state = 'waiting_host', error = NULL WHERE (host_id = ? AND session_id IN (${slots(linkedKeys)}) AND state = 'held') OR (id = ? AND state = 'delivering' AND dispatch_pid = ?)`)
        .run(hostId, ...linkedKeys, next.id, process.pid);
      publish(sessionId, hostId);
    }
  }).catch((error: unknown) => {
    release();
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tau] outbox delivery failed: ${message}`);
    try {
      // Thrown before the claim, it is not sent and nothing else would pump it again.
      const state = row(next.id)?.state;
      if (state === "delivering") fail(next, message, true);
      else if (state === "held" || state === "waiting_host") retry(next);
      // Settled, but publishing or the next pump failed (a busy store): resume the session later.
      else schedulePump(next.session_id, next.host_id);
    } catch {
      // The store itself failed; the next start settles a "delivering" row.
    }
  });
}

function pumpAll(): void {
  try {
    const rows = db().prepare("SELECT DISTINCT host_id, session_id FROM entries WHERE state IN ('held', 'waiting_host', 'delivering')").all() as { host_id: string; session_id: string }[];
    for (const { host_id, session_id } of rows) pump(session_id, host_id);
  } catch (error) {
    console.warn(`[tau] outbox: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** At startup: settle what the last server left in flight, then dispatch stored entries now and on every host link.
 * A second instance sharing the agent dir must not fail or resend another live process's delivery. */
export function startOutbox(): void {
  const state = outbox();
  if (state.started) return;
  clearTimeout(state.startupRetry);
  state.startupRetry = undefined;
  try {
    db();
    recoverDelivering(undefined, undefined, true);
    pruneDelivered(db(), Date.now() - KEEP_DELIVERED_MS);
    db().prepare("DELETE FROM completed_uploads WHERE at < ?").run(Date.now() - STAGED_MAX_AGE_MS);
  } catch (error) {
    console.warn(`[tau] outbox startup failed: ${error instanceof Error ? error.message : String(error)}`);
    state.startupRetry = setTimeout(() => {
      state.startupRetry = undefined;
      if (globalThis.__tauOutbox === state) startOutbox();
    }, RETRY_MS);
    state.startupRetry.unref?.();
    return;
  }
  process.once("exit", closeOutboxStore);
  const detachHello = onHostHello(() => { if (globalThis.__tauOutbox === state && state.started) pumpAll(); });
  // Restores can finish after the caller's timeout, without another hello or a successful route reply. Re-read only
  // the host that signalled a change, and wake only sessions it now lists with held work. Coalesce bursts, but do
  // not lose a second change arriving while the first list is in flight.
  let attached = true;
  const checking = new Set<string>();
  const dirty = new Set<string>();
  const hostRetries = new Map<string, NodeJS.Timeout>();
  const wakeHost = async (hostId: string): Promise<void> => {
    if (!attached || !state.started) return;
    dirty.add(hostId);
    if (checking.has(hostId)) return;
    // A fresh event supersedes this host's timer. Success must not leave an older failed attempt polling it.
    const scheduled = hostRetries.get(hostId);
    if (scheduled) {
      clearTimeout(scheduled);
      state.retries?.delete(scheduled);
      hostRetries.delete(hostId);
    }
    checking.add(hostId);
    try {
      while (dirty.delete(hostId) && attached && state.started) {
        // Only this host's copies: the same id held for another host is another session.
        const held = db().prepare("SELECT DISTINCT session_id FROM entries WHERE host_id = ? AND state IN ('held', 'waiting_host')").all(hostId) as { session_id: string }[];
        if (!held.length) continue;
        const host = getHost(hostId);
        if (!host || !isLinkUp(host.status())) continue; // the next hello resumes offline work
        const sessions = await host.sessionOps.listSessions();
        if (!attached || !state.started) return;
        const ids = new Set(sessions.map((session) => session.id));
        for (const session_id of new Set(held.map((row) => row.session_id))) if (ids.has(session_id)) {
          // A change can race the dispatcher's archive read. Leave one wake to run after that claim releases.
          const key = sessionHostKey(hostId, session_id);
          if (state.busy.has(key)) wakes.add(key);
          else pump(session_id, hostId);
        }
      }
    } catch {
      if (attached && state.started) {
        const retries = (state.retries ??= new Set());
        const timer = setTimeout(() => {
          retries.delete(timer);
          hostRetries.delete(hostId);
          if (attached) void wakeHost(hostId);
        }, RETRY_MS);
        retries.add(timer);
        hostRetries.set(hostId, timer);
        timer.unref?.();
      }
    } finally {
      checking.delete(hostId);
    }
  };
  const wakes = (state.wakes ??= new Set());
  const detachSessionChanges = onHostSessionsChanged((hostId) => { void wakeHost(hostId); });
  const detachFrames = tapSessionFrames((wrapper, event) => {
    if (globalThis.__tauOutbox === state && state.started) onChildExit(wrapper, event);
  });
  state.detach = () => {
    attached = false;
    for (const timer of hostRetries.values()) {
      clearTimeout(timer);
      state.retries?.delete(timer);
    }
    hostRetries.clear();
    wakes.clear();
    detachSessionChanges();
    process.removeListener("exit", closeOutboxStore);
    detachHello();
    detachFrames();
  };
  // A live owner at boot can die later without another add or hello. Recover its claim, never resend it.
  const maintenance = setInterval(() => {
    if (globalThis.__tauOutbox !== state) { clearInterval(maintenance); return; }
    try {
      const rows = db().prepare("SELECT DISTINCT host_id, session_id FROM entries WHERE state = 'delivering'").all() as { host_id: string; session_id: string }[];
      for (const { host_id, session_id } of rows) pump(session_id, host_id);
    } catch (error) {
      console.warn(`[tau] outbox maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, RETRY_MS);
  state.maintenance = maintenance;
  maintenance.unref?.();
  // SQLite changes made by a peer server do not pass through this process's publish(). Prepared per tick through db():
  // a hot reload can replace (and finalize) the connection, and the watcher must follow it.
  let version: number | undefined;
  let observed: Database | undefined;
  const pending = state.pendingNotifications;
  const changes = setInterval(() => {
    if (globalThis.__tauOutbox !== state) { clearInterval(changes); return; }
    if (state.listeners.size === 0) { pending.clear(); return; }
    try {
      const store = db();
      const next = store.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version;
      // data_version is per connection: a replacement's baseline can equal the old value yet hide a peer change in between.
      if (store !== observed || next !== version) {
        for (const sessionId of [...state.listeners.keys()]) notifyListeners(sessionId);
        observed = store;
        version = next;
      }
      const now = performance.now();
      for (const [sessionId, retryAt] of pending) {
        if (now >= retryAt) notifyListeners(sessionId);
      }
    } catch (error) {
      console.warn(`[tau] outbox change check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 250);
  state.changes = changes;
  changes.unref?.();
  state.started = true;
  pumpAll();
}

/** A live instance owns its delivery. An orphaned claim is uncertain, never replayed by this dispatcher. */
function recoverDelivering(sessionId?: string, hostId?: string, startup = false): void {
  const inFlight = db().prepare(`SELECT id, session_id, host_id, dispatch_pid FROM entries WHERE state = 'delivering'${sessionId ? " AND session_id = ? AND host_id = ?" : ""}`)
    .all(...(sessionId ? [sessionId, hostId ?? LOCAL_HOST_ID] : [])) as { id: string; session_id: string; host_id: string; dispatch_pid: number | null }[];
  for (const entry of inFlight) {
    // At startup a same-PID row is usually a reused PID from the last run; only a claim this process holds in memory is live.
    if (entry.dispatch_pid === process.pid && (!startup || outbox().busy.has(sessionHostKey(entry.host_id, entry.session_id)))) continue;
    if (entry.dispatch_pid && entry.dispatch_pid !== process.pid) {
      try {
        process.kill(entry.dispatch_pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") continue;
      }
    }
    // The orphaned claim exactly as inspected: a row that moved on since then is left alone.
    const orphaned = db().prepare("UPDATE entries SET state = 'failed', error = ?, may_have_been_sent = 1, previous_entry_ids = NULL WHERE id = ? AND state = 'delivering' AND dispatch_pid IS ?")
      .run("tau restarted while this message was being delivered", entry.id, entry.dispatch_pid);
    if (orphaned.changes) publish(entry.session_id, entry.host_id);
  }
}

/** Lifecycle bookkeeping only. Text equality is NOT delivery identity, especially after an unknown/lost reply.
 * An entry this process claimed but whose command no wrapper has begun writing is left to its dispatcher, which
 * retries it. */
function onChildExit(wrapper: AgentSessionWrapper, event: AgentEvent): void {
  if (event.type !== "process_exit") return;
  const preparing = outbox().preparing;
  const hostId = wrapper.host?.id ?? LOCAL_HOST_ID;
  for (const key of sessionKeys(wrapper.sessionId, hostId)) {
    const inFlight = db().prepare(`SELECT ${COLUMNS} FROM entries WHERE host_id = ? AND session_id = ? AND state = 'delivering' AND dispatch_pid = ?`).all(hostId, key, process.pid) as Row[];
    for (const entry of inFlight) {
      const command = preparing?.get(entry.id);
      if (!command || nativeWriteStarted(command)) fail(entry, "pi exited while this message was being delivered", true);
    }
  }
}

/** After one entry's delivery: "next" when the session's next entry may go now (this one left the queue, or failed),
 * "offline" when the host is down (every entry waits for its next hello), "wait" when a timer or a restore resumes it. */
type Outcome = "next" | "wait" | "offline";

async function deliver(entry: Row): Promise<Outcome> {
  const { session_id: sessionId, host_id: hostId } = entry;
  if (entry.uploads && Date.now() - entry.created_at > STAGED_MAX_AGE_MS) {
    // The host's sweep has removed the staged files by now (spec O3): never send the message without them.
    return fail(entry, "The attached files are gone: attach them again", false);
  }
  // Start (or join) the session's pi first, as any command would, so the echo watch is on the wrapper that gets it.
  const priorWrapper = getRpcSession(sessionId, hostId);
  const generation = priorWrapper?.getMessageCommandGeneration() ?? 0;
  const competingPending = priorWrapper?.hasPendingMessageCommands() ?? false;
  const started = await runAgentCommand(sessionId, { type: "get_state" }, entry.owner, { hostId });
  const wrapper = getRpcSession(sessionId, hostId);
  const current = row(entry.id);
  if (!current || (current.state !== "held" && current.state !== "waiting_host")) return "next";
  if (!started.ok) return refused(current, started, false);
  if (!wrapper?.isAlive()) return retry(current);
  const baseline = await started.json() as { data?: { queuedMessages?: unknown; supportsClientMessageIds?: boolean } };
  // A pi child without client message IDs (no tau extension) gets the earlier text-matched hand-off; its rows retire without a bridge.
  const correlated = baseline.data?.supportsClientMessageIds === true;
  if (wrapper.getMessageCommandGeneration() !== (priorWrapper === wrapper ? generation : 0)
    || (competingPending && !wrapper.hasPendingMessageCommands())) return "next";
  if (competingPending && !wrapper.isRunning()) {
    try {
      if (await wrapper.clearMessageProofTaintIfSettled()) return "next";
    } catch (error) {
      // Nothing of this entry was written: a failed or timed-out read leaves it unsent, so it is tried again.
      console.warn(`[tau] outbox: settle read failed: ${error instanceof Error ? error.message : String(error)}`);
      return retry(current);
    }
  }
  // pi takes a prompt beside tau's `!!` shell command; a follow-up queued with no turn would wait for the next one.
  const idle = !wrapper.isRunning(true);
  const keys = sessionKeys(sessionId, hostId);
  // A cold start can discover native aliases. Re-select across them before claiming, so an older alias wins.
  const oldest = db().prepare(`SELECT id FROM entries WHERE host_id = ? AND session_id IN (${slots(keys)}) AND state IN ('held', 'waiting_host') ORDER BY rowid LIMIT 1`).get(hostId, ...keys) as { id: string } | null;
  if (oldest?.id !== current.id) return "next";
  // Give legacy accepted authority its immutable generation before transcript/attachment preparation can yield.
  for (const receipt of current.upload_receipts ? JSON.parse(current.upload_receipts) as OutboxUploadReceipt[] : []) {
    if (receipt.completionKey !== undefined) continue;
    const stored = completedUpload(receipt.id);
    if (stored && !stored.proof && stored.owner === (receipt.owner ?? current.owner)
      && (receipt.completedAt === undefined || receipt.completedAt === stored.at)
      && stored.receipt.hostId === receipt.hostId && stored.receipt.name === receipt.name
      && stored.receipt.size === receipt.size && stored.receipt.type === receipt.type) saveCompletedUpload(stored.owner, stored.receipt);
  }
  const savedUploads = row(current.id)?.upload_receipts;
  const uploadReceipts = savedUploads ? JSON.parse(savedUploads) as OutboxUploadReceipt[] : undefined;
  if (uploadReceipts?.some((receipt) => receipt.completedAt !== undefined && Date.now() - receipt.completedAt > STAGED_MAX_AGE_MS)) {
    return fail(current, "The attached files are gone: attach them again", false);
  }
  const origin = storedOrigin(current.origin);
  const command: Record<string, unknown> = {
    ...commandOf(current, !idle),
    message: current.message,
    ...(correlated ? { clientMessageId: current.id } : {}),
    ...(current.images ? { images: JSON.parse(current.images) as unknown } : {}),
    ...(current.uploads ? { uploads: JSON.parse(current.uploads) as unknown } : {}),
  };
  const claimed = db().prepare(`UPDATE entries SET state = 'delivering', dispatch_pid = ? WHERE id = ? AND state IN ('held', 'waiting_host') AND NOT EXISTS (SELECT 1 FROM entries WHERE host_id = ? AND session_id IN (${slots(keys)}) AND state = 'delivering')`).run(process.pid, current.id, hostId, ...keys);
  if (!claimed.changes) return "wait";
  // Claimed but not written yet: anything that stops it before a wrapper begins its native write (including
  // attachment preparation and fences inside runAgentCommand) leaves it unsent, so it is retried.
  const preparing = (outbox().preparing ??= new Map());
  preparing.set(current.id, command);
  let previousEntryIds: string[] | undefined;
  let handedOn = false;
  try {
    if (idle) {
      try {
        const boundary = await wrapper.withPendingCommand(() => wrapper.host.sessionOps.readContext(wrapper.sessionId, undefined, { boundary: true, deferThinking: true, deferMedia: true, includePreCompaction: false, sync: null }));
        let entryIds: string[];
        if (boundary.ok && isRecord(boundary.value) && Array.isArray(boundary.value.entryIds) && boundary.value.entryIds.every((id) => typeof id === "string")) {
          entryIds = boundary.value.entryIds;
        } else if (!boundary.ok && boundary.status === 404 && !(await wrapper.host.sessionFileExists(wrapper.sessionFile))) {
          entryIds = [];
        } else if (!boundary.ok) {
          return refused(current, Response.json({ error: boundary.error, code: boundary.code, hostOffline: boundary.code === "host_offline" }, { status: boundary.status }), false);
        } else {
          return fail(current, "Could not read the saved transcript boundary before sending", false);
        }
        db().prepare("UPDATE entries SET previous_entry_ids = ? WHERE id = ?").run(JSON.stringify(entryIds), current.id);
        previousEntryIds = entryIds;
        if (Buffer.byteLength(JSON.stringify(outboxSnapshot(sessionId, hostId))) > MAX_OUTBOX_BYTES) {
          return fail(current, "The saved transcript boundary exceeds the outbox snapshot limit", false);
        }
      } catch (error) {
        return refused(current, apiErrorResponse(error), false);
      }
    }
    if (!wrapper.isAlive()) return retry(current);
    if (row(current.id)?.state !== "delivering") return "next";
    if (wrapper.getMessageCommandGeneration() !== (priorWrapper === wrapper ? generation : 0)
      || (competingPending && !wrapper.hasPendingMessageCommands())) {
      // Another command finished during preparation, before THIS native write: discard stale mode/queue/history data.
      setState(current.id, "held");
      publish(sessionId, hostId);
      return "next";
    }
    handedOn = true;
  } catch (error) {
    console.warn(`[tau] outbox: ${error instanceof Error ? error.message : String(error)}`);
    return retry(current);
  } finally {
    if (!handedOn) preparing.delete(current.id);
  }
  const replacement = wrapper.watchMessageReplacement(command, baseline.data?.queuedMessages, priorWrapper === wrapper ? generation : 0, competingPending, previousEntryIds);
  publish(sessionId, hostId);
  try {
    // attachUploads mutates this same command before writing it: the watcher matches the final attachment block too.
    const response = await runAgentCommand(sessionId, command, current.owner, { hostId, trustedUploads: uploadReceipts, trustedOrigin: origin });
    if (!response.ok) {
      // Nothing was written: a gone child is retried, and any other refusal is classified as not sent.
      const written = nativeWriteStarted(command);
      if (!written && !wrapper.isAlive()) return retry(current);
      return refused(current, response, written);
    }
    const body = await response.json() as { data?: { agentInvoked?: boolean } };
    if (row(current.id)?.state === "failed") return "next";
    const handOff = body.data?.agentInvoked === false ? {} : await replacement.handOff();
    // Proven dropped (spec O6) leaves the child untainted, like a delivery: no settle read before the next message.
    if (!handOff.error || handOff.mayHaveBeenSent === false) wrapper.confirmMessageCommandGeneration((priorWrapper === wrapper ? generation : 0) + 1);
    if (handOff.error) return fail(current, handOff.error, handOff.mayHaveBeenSent === true);
    retire(current.id, body.data?.agentInvoked === false ? "none" : correlated ? "native" : "uncorrelated");
    publish(sessionId, hostId);
    return "next";
  } finally {
    preparing.delete(current.id);
    replacement.stop();
  }
}

/** How an entry goes to pi (spec O3): with no run every entry is a bare prompt (pi's `follow_up` only queues, so
 * with no turn it would wait for the next one; a prompt with streamingBehavior skips the wrapper's run bookkeeping). A
 * run started since the idle read makes pi refuse it, which leaves the entry Not sent with Retry. During a run a prompt
 * goes as a follow-up. pi refuses
 * extension commands in `steer` and `follow_up`, so a slash command sent during a run goes as a prompt with its
 * streamingBehavior (queued like a follow-up or steer). */
function commandOf(entry: Row, running: boolean): { type: string; streamingBehavior?: "steer" | "followUp" } {
  const slash = entry.message.startsWith("/");
  if (!running) return { type: "prompt" };
  if (slash) return { type: "prompt", streamingBehavior: entry.mode === "steer" ? "steer" : "followUp" };
  return { type: entry.mode === "steer" ? "steer" : "follow_up" };
}


function fail(entry: Row, error: string, mayHaveBeenSent: boolean): Outcome {
  if (setState(entry.id, "failed", error, mayHaveBeenSent)) publish(entry.session_id, entry.host_id);
  return "next";
}

/** Not sent yet, for a passing reason: held again and tried after RETRY_MS. */
function retry(entry: Row): Outcome {
  if (!setState(entry.id, "held")) return "next";
  publish(entry.session_id, entry.host_id);
  schedulePump(entry.session_id, entry.host_id);
  return "wait";
}

function schedulePump(sessionId: string, hostId: string): void {
  const state = outbox();
  const retries = (state.retries ??= new Set());
  const timer = setTimeout(() => {
    retries.delete(timer);
    if (globalThis.__tauOutbox === state) pump(sessionId, hostId);
  }, RETRY_MS);
  retries.add(timer);
  timer.unref?.();
}

/** A non-2xx answer to the start (`sent` false) or to the message itself (spec O6). */
async function refused(entry: Row, response: Response, sent: boolean): Promise<Outcome> {
  const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown; hostOffline?: unknown; delivery?: unknown };
  const current = row(entry.id);
  if (!current || current.state === "delivered" || current.state === "failed") return "next";
  const error = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
  // Nothing reached pi: the session's entries wait for the host's next hello.
  if (body.hostOffline === true && (!sent || body.delivery === "refused")) return "offline";
  // A timed-out status read (`session_state_timeout`, e.g. pi busy streaming) is the preflight, not the message.
  if (body.code === "session_busy" || body.code === "session_restarting"
    || (!sent && (body.code === "host_timeout" || body.code === "host_sessions_unavailable" || body.code === "session_state_timeout"))) return retry(entry);
  // Only a missing session can be an archived one; any other 404 (an upload that is gone, say) is that refusal.
  if (!sent && response.status === 404 && body.code === "session_not_found") {
    const { state: archive } = await archiveState(entry.session_id, entry.host_id);
    // An unreadable archive cannot prove the session is gone: never failed. A passing failure is tried again; one
    // only a host's next hello can change waits for it, as for an offline host, without a timer.
    if (archive === "retry") return retry(entry);
    if (archive === "hello") return "offline";
    if (archive === "archived") {
      // An archived session keeps its entries held until it is restored (spec O6).
      if (!setState(entry.id, "held")) return "next";
      publish(entry.session_id, entry.host_id);
      return "wait";
    }
    // The archive and active lists are separate reads: a restore can move the session between them after the
    // command's 404. Before declaring it gone, discover its active owner again. A discovery failure is uncertainty,
    // not deletion; a deferred host-change wake must likewise get a chance to resume this still-unsent entry.
    const resolved = await resolveSessionHostOr404(entry.session_id, entry.host_id);
    if ("host" in resolved) {
      if (outbox().wakes?.has(sessionHostKey(entry.host_id, entry.session_id))) {
        if (!setState(entry.id, "held")) return "next";
        publish(entry.session_id, entry.host_id);
        return "wait";
      }
      return retry(entry);
    }
    if (resolved.response.status !== 404) return refused(entry, resolved.response, false);
    if (outbox().wakes?.has(sessionHostKey(entry.host_id, entry.session_id))) return retry(entry);
  }
  // A lost reply (delivery unknown), a server error or an unresponsive child after the message went: pi may have it.
  return fail(entry, error, sent && (response.status >= 500 || body.code === "session_unresponsive"));
}

/** `archived`/`absent`: every source answered. Otherwise the archive could not be read: `hello` while only a host's
 * next hello can change that (its link is down, or an older daemon answered 501 and may hold archives it cannot
 * list), `retry` for a failure that may pass by itself (timeout, bad answer, unreadable local archive). */
type ArchiveState = "archived" | "absent" | "hello" | "retry";
type ArchiveRead = boolean | "hello" | "retry";

/** Whether `sessionId` is in an archive: this machine's, or any linked host's (as GET /api/sessions/archive lists them),
 * or only `hostId`'s when given; `hostId` in the answer is the host whose archive lists it. An unreadable archive is
 * never `absent`: the session may be in it. */
async function archiveState(sessionId: string, hostId?: string | null): Promise<{ state: ArchiveState; hostId?: string }> {
  const linked = listHosts().filter((row) => !hostId || row.id === hostId);
  const local = !hostId || hostId === LOCAL_HOST_ID;
  const hosts = [...(local ? [LOCAL_HOST_ID] : []), ...linked.map((row) => row.id)];
  const reads: Promise<ArchiveRead>[] = [
    ...(local
      ? [listArchivedSessions().then((archives) => archives.some((archive) => archive.id === sessionId), (): ArchiveRead => "retry")]
      : []),
    ...linked.map(async (row): Promise<ArchiveRead> => {
      const host = isLinkUp(row.status) ? getHost(row.id) : null;
      if (!host) return "hello";
      try {
        return (await host.sessionOps.listArchives()).some((archive) => archive.id === sessionId);
      } catch (error) {
        return error instanceof HostOpError && (error.status === 501 || error.code === "host_offline") ? "hello" : "retry";
      }
    }),
  ];
  const found = await Promise.all(reads);
  const archivedAt = found.indexOf(true);
  if (archivedAt !== -1) return { state: "archived", hostId: hosts[archivedAt] };
  return { state: found.includes("retry") ? "retry" : found.includes("hello") ? "hello" : "absent" };
}
