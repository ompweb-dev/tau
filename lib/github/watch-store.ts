import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { getAgentDir } from "../pi/paths";
import type { MessageOrigin } from "../message-origin";
import { isRecord } from "../type-guards";
import type { ItemKind } from "./api";
import type { WatchCursor } from "./events";

/**
 * Server-only persistent GitHub watch state in tau's data directory: which
 * session watches which item, the cursor each watch has reported up to, the
 * update a watch is about to post (so a crash re-adds the same outbox entry),
 * the comments the agent posted, and the read grants. Every tau instance
 * sharing the agent directory shares it; SQLite serializes their writes.
 */

export const MAX_WATCHES_PER_SESSION = 20;

export interface Watch {
  sessionId: string;
  /** The session's host: the same id on another host is another session, with its own watches. */
  hostId: string;
  itemKey: string;
  kind: ItemKind;
  cursor: WatchCursor;
  registrationId: string;
  /** Registration time (ms), used to order watches. */
  createdAt: number;
}

export interface PendingBatch {
  entryId: string;
  message: string;
  origin?: MessageOrigin;
}

export interface PendingUpdate {
  entryId: string;
  cursor: WatchCursor;
  final: boolean;
  batches: PendingBatch[];
  batchIndex: number;
}

export function repoKeyOf(target: { owner: string; repo: string }): string {
  return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
}

export function itemKeyOf(target: { owner: string; repo: string; number: number; kind?: "workflow_run" }): string {
  if (target.kind === "workflow_run") return `https://github.com/${repoKeyOf(target)}/actions/runs/${target.number}`;
  return `${repoKeyOf(target)}#${target.number}`;
}

declare global {
  var __tauGithubWatchStore: { path: string; db: Database } | undefined;
}

// Session state is keyed by (host_id, session_id): the same id on two hosts is two sessions.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (host_id TEXT NOT NULL, session_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, cursor_json TEXT NOT NULL, created_at INTEGER NOT NULL, registration_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (host_id, session_id, item_key));
CREATE TABLE IF NOT EXISTS pending (host_id TEXT NOT NULL, session_id TEXT NOT NULL, item_key TEXT NOT NULL, entry_id TEXT NOT NULL, message TEXT NOT NULL, cursor_json TEXT NOT NULL, final INTEGER NOT NULL, batches_json TEXT NOT NULL DEFAULT '[]', batch_index INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (host_id, session_id, item_key));
CREATE TABLE IF NOT EXISTS watch_intents (token TEXT NOT NULL PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL, item_key TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS watch_intents_host_session_item ON watch_intents (host_id, session_id, item_key);
CREATE TABLE IF NOT EXISTS posted (item_key TEXT NOT NULL, comment_id TEXT NOT NULL, PRIMARY KEY (item_key, comment_id));
CREATE TABLE IF NOT EXISTS read_grants (host_id TEXT NOT NULL, session_id TEXT NOT NULL, repo_key TEXT NOT NULL, PRIMARY KEY (host_id, session_id, repo_key));
CREATE TABLE IF NOT EXISTS active_posts (item_key TEXT NOT NULL, token TEXT NOT NULL PRIMARY KEY, lease_until INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS active_posts_item_lease ON active_posts (item_key, lease_until);
`;
/** Longer than the 30 s `gh` command timeout; heartbeats cover follow-up reconciliation. */
const POST_LEASE_MS = 90_000;
const POST_RENEW_MS = 30_000;

function transaction<T>(db: Database, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

const storeDir = (): string => join(getAgentDir(), "tau");
const storePath = (): string => join(storeDir(), "github-watches.sqlite");

/** The store for the current agent directory; reopened when PI_CODING_AGENT_DIR changes. */
function db(): Database {
  const dir = storeDir();
  const path = storePath();
  const cached = globalThis.__tauGithubWatchStore;
  if (cached?.path === path) return cached.db;
  const database = open(dir, path);
  // Only a working store replaces the cached one; a failed open leaves it usable.
  closeWatchStore();
  globalThis.__tauGithubWatchStore = { path, db: database };
  return database;
}

/**
 * The store only if this agent directory has one: a session delete or move must not create (and on Windows
 * hold open) a store nobody watches from. A file that exists but cannot be opened still throws.
 */
function existingDb(): Database | undefined {
  const path = storePath();
  return globalThis.__tauGithubWatchStore?.path === path || existsSync(path) ? db() : undefined;
}

/** Closes the cached store. `close(true)` finalizes the statements still alive: without it the file stays open until GC, and Windows keeps it locked. */
export function closeWatchStore(): void {
  globalThis.__tauGithubWatchStore?.db.close(true);
  globalThis.__tauGithubWatchStore = undefined;
}

function open(dir: string, path: string): Database {
  mkdirSync(dir, { recursive: true });
  const database = new Database(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    // Switching a new database to WAL takes an exclusive lock that ignores busy_timeout; another tau may hold it.
    for (let attempt = 0; ; attempt++) {
      try {
        database.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        if (!isRecord(error) || error.errno !== 5 || attempt >= 250) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    // NORMAL is the documented safe pairing with WAL: no corruption, only the last commits can be lost on power failure.
    database.exec("PRAGMA synchronous = NORMAL");
    transaction(database, () => {
      // Pre-alpha: a store from before host keys is dropped, not migrated (its primary keys lack the host).
      const columns = database.prepare<{ name: string }, []>("PRAGMA table_info(watches)").all();
      if (columns.length && !columns.some(({ name }) => name === "host_id")) {
        database.exec("DROP TABLE IF EXISTS watches; DROP TABLE IF EXISTS pending; DROP TABLE IF EXISTS watch_intents; DROP TABLE IF EXISTS read_grants");
      }
      database.exec(SCHEMA);
    });
    return database;
  } catch (error) {
    database.close(true);
    throw error;
  }
}

// ---------------------------------------------------------------- watches

type WatchRow = { host_id: string; session_id: string; item_key: string; kind: ItemKind; cursor_json: string; registration_id: string; created_at: number };

const toWatch = (row: WatchRow): Watch => ({
  sessionId: row.session_id,
  hostId: row.host_id,
  itemKey: row.item_key,
  kind: row.kind,
  cursor: JSON.parse(row.cursor_json) as WatchCursor,
  registrationId: row.registration_id,
  createdAt: row.created_at,
});

function insertWatch(d: Database, sessionId: string, hostId: string, itemKey: string, kind: ItemKind, baseline: WatchCursor): "added" | "exists" | "limit" {
  if (d.prepare("SELECT 1 FROM watches WHERE host_id = ? AND session_id = ? AND item_key = ?").get(hostId, sessionId, itemKey)) return "exists";
  const { n } = d.prepare<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM watches WHERE host_id = ? AND session_id = ?").get(hostId, sessionId)!;
  if (n >= MAX_WATCHES_PER_SESSION) return "limit";
  d.prepare("INSERT INTO watches (host_id, session_id, item_key, kind, cursor_json, created_at, registration_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(hostId, sessionId, itemKey, kind, JSON.stringify(baseline), Date.now(), randomUUID());
  return "added";
}

/** `exists` leaves the stored cursor as it is; `limit` refuses the watch beyond MAX_WATCHES_PER_SESSION. */
export function addWatch(sessionId: string, hostId: string, itemKey: string, kind: ItemKind, baseline: WatchCursor): "added" | "exists" | "limit" {
  const d = db();
  return transaction(d, () => insertWatch(d, sessionId, hostId, itemKey, kind, baseline));
}

/** Records one in-flight registration so a later unwatch can invalidate it across server processes. */
export function beginWatchIntent(sessionId: string, hostId: string, itemKey: string): string {
  const token = randomUUID();
  db().prepare("INSERT INTO watch_intents (token, host_id, session_id, item_key) VALUES (?, ?, ?, ?)").run(token, hostId, sessionId, itemKey);
  return token;
}

/** Removes only this request's provisional registration, including on a closed item, abort, or fetch error. */
export function cancelWatchIntent(token: string): void {
  const d = existingDb();
  if (!d) return;
  d.prepare("DELETE FROM watch_intents WHERE token = ?").run(token);
}

/** Registers only while this request's intent still belongs to the caller's current session. */
export function registerWatchIntent(
  token: string,
  sessionId: string,
  hostId: string,
  itemKey: string,
  kind: ItemKind,
  baseline: WatchCursor,
): "added" | "exists" | "limit" | "cancelled" {
  const d = db();
  return transaction(d, () => {
    const intent = d.prepare("SELECT 1 FROM watch_intents WHERE token = ? AND host_id = ? AND session_id = ? AND item_key = ?").get(token, hostId, sessionId, itemKey);
    if (!intent) return "cancelled";
    const result = insertWatch(d, sessionId, hostId, itemKey, kind, baseline);
    d.prepare("DELETE FROM watch_intents WHERE token = ?").run(token);
    return result;
  });
}

export function removeWatch(sessionId: string, hostId: string, itemKey: string): boolean {
  const d = db();
  return transaction(d, () => {
    d.prepare("DELETE FROM pending WHERE host_id = ? AND session_id = ? AND item_key = ?").run(hostId, sessionId, itemKey);
    d.prepare("DELETE FROM watch_intents WHERE host_id = ? AND session_id = ? AND item_key = ?").run(hostId, sessionId, itemKey);
    return d.prepare("DELETE FROM watches WHERE host_id = ? AND session_id = ? AND item_key = ?").run(hostId, sessionId, itemKey).changes > 0;
  });
}

/** The session (this host's copy) is gone: its watches, pending updates and read grants go. */
export function removeSessionWatches(
  sessionId: string,
  hostId: string,
  expected?: { itemKey: string; registrationId: string; entryId?: string },
): void {
  const d = existingDb();
  if (!d) return;
  transaction(d, () => {
    if (expected) {
      const match = expected.entryId === undefined
        ? d.prepare("SELECT 1 FROM watches WHERE host_id = ? AND session_id = ? AND item_key = ? AND registration_id = ?").get(hostId, sessionId, expected.itemKey, expected.registrationId)
        : d.prepare("SELECT 1 FROM watches w JOIN pending p USING (host_id, session_id, item_key) WHERE w.host_id = ? AND w.session_id = ? AND w.item_key = ? AND w.registration_id = ? AND p.entry_id = ?").get(hostId, sessionId, expected.itemKey, expected.registrationId, expected.entryId);
      if (!match) return;
    }
    for (const table of ["watch_intents", "pending", "watches", "read_grants"]) {
      d.prepare(`DELETE FROM ${table} WHERE host_id = ? AND session_id = ?`).run(hostId, sessionId);
    }
  });
}

export function listWatches(): Watch[] {
  return db().prepare<WatchRow, []>("SELECT host_id, session_id, item_key, kind, cursor_json, registration_id, created_at FROM watches ORDER BY created_at").all().map(toWatch);
}

/** Commits the cursor or removes a final watch only after all persisted batches are accepted. */
export function commitUpdate(sessionId: string, hostId: string, itemKey: string, registrationId: string, entryId: string, cursor: WatchCursor, final: boolean): boolean {
  const d = db();
  return transaction(d, () => {
    const match = d.prepare(
      "SELECT 1 FROM watches JOIN pending USING (host_id, session_id, item_key) WHERE watches.host_id = ? AND watches.session_id = ? AND watches.item_key = ? AND watches.registration_id = ? AND pending.entry_id = ? AND pending.batch_index > 0 AND pending.batch_index = json_array_length(pending.batches_json)",
    ).get(hostId, sessionId, itemKey, registrationId, entryId);
    if (!match) return false;
    d.prepare("DELETE FROM pending WHERE host_id = ? AND session_id = ? AND item_key = ? AND entry_id = ?").run(hostId, sessionId, itemKey, entryId);
    if (final) d.prepare("DELETE FROM watches WHERE host_id = ? AND session_id = ? AND item_key = ? AND registration_id = ?").run(hostId, sessionId, itemKey, registrationId);
    else d.prepare("UPDATE watches SET cursor_json = ? WHERE host_id = ? AND session_id = ? AND item_key = ? AND registration_id = ?").run(JSON.stringify(cursor), hostId, sessionId, itemKey, registrationId);
    return true;
  });
}

/** Commits one accepted batch only if it is still the expected batch for this registration. */
export function advancePendingBatch(sessionId: string, hostId: string, itemKey: string, registrationId: string, entryId: string, expectedIndex: number): boolean {
  const { changes } = db()
    .prepare(
      "UPDATE pending SET batch_index = batch_index + 1 WHERE host_id = ? AND session_id = ? AND item_key = ? AND entry_id = ? AND batch_index = ? AND batch_index < json_array_length(batches_json) AND EXISTS (SELECT 1 FROM watches WHERE watches.host_id = pending.host_id AND watches.session_id = pending.session_id AND watches.item_key = pending.item_key AND watches.registration_id = ?)",
    )
    .run(hostId, sessionId, itemKey, entryId, expectedIndex, registrationId);
  return changes > 0;
}

/** Advances a quiet cursor only from the exact state that was fetched and diffed. */
export function advanceCursor(sessionId: string, hostId: string, itemKey: string, registrationId: string, baseCursor: WatchCursor, cursor: WatchCursor): boolean {
  const { changes } = db()
    .prepare(
      "UPDATE watches SET cursor_json = ? WHERE host_id = ? AND session_id = ? AND item_key = ? AND registration_id = ? AND cursor_json = ? AND NOT EXISTS (SELECT 1 FROM pending WHERE pending.host_id = watches.host_id AND pending.session_id = watches.session_id AND pending.item_key = watches.item_key) AND NOT EXISTS (SELECT 1 FROM active_posts WHERE active_posts.item_key = watches.item_key AND active_posts.lease_until > ?)",
    )
    .run(JSON.stringify(cursor), hostId, sessionId, itemKey, registrationId, JSON.stringify(baseCursor), Date.now());
  return changes > 0;
}

// ---------------------------------------------------------------- pending updates

type PendingRow = { entry_id: string; message: string; cursor_json: string; final: number; batches_json: string; batch_index: number };

const toPending = (row: PendingRow): PendingUpdate => ({
  entryId: row.entry_id,
  cursor: JSON.parse(row.cursor_json) as WatchCursor,
  final: row.final === 1,
  batches: JSON.parse(row.batches_json) as PendingBatch[],
  batchIndex: row.batch_index,
});

/**
 * Atomically claims all update batches for this registration and base cursor.
 * Returns only the persisted row; losers never deliver their local snapshot.
 */
export function claimPending(
  sessionId: string,
  hostId: string,
  itemKey: string,
  registrationId: string,
  baseCursor: WatchCursor,
  pending: PendingUpdate,
  eventIds: readonly string[],
): PendingUpdate | null {
  if (!pending.batches.length) throw new Error("A pending update must contain at least one batch.");
  const d = db();
  return transaction(d, () => {
    const now = Date.now();
    d.prepare("DELETE FROM active_posts WHERE lease_until <= ?").run(now);
    const { changes } = d
      .prepare(
        "INSERT INTO pending (host_id, session_id, item_key, entry_id, message, cursor_json, final, batches_json, batch_index) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0 WHERE EXISTS (SELECT 1 FROM watches WHERE host_id = ? AND session_id = ? AND item_key = ? AND registration_id = ? AND cursor_json = ?) AND NOT EXISTS (SELECT 1 FROM pending WHERE host_id = ? AND session_id = ? AND item_key = ?) AND NOT EXISTS (SELECT 1 FROM active_posts WHERE item_key = ? AND lease_until > ?) AND NOT EXISTS (SELECT 1 FROM posted WHERE item_key = ? AND comment_id IN (SELECT value FROM json_each(?)))",
      )
      .run(hostId, sessionId, itemKey, pending.entryId, pending.batches[0].message, JSON.stringify(pending.cursor), pending.final ? 1 : 0, JSON.stringify(pending.batches), hostId, sessionId, itemKey, registrationId, JSON.stringify(baseCursor), hostId, sessionId, itemKey, itemKey, now, itemKey, JSON.stringify(eventIds));
    if (changes === 0) return null;
    const row = d
      .prepare<PendingRow, [string, string, string]>("SELECT entry_id, cursor_json, final, batches_json, batch_index FROM pending WHERE host_id = ? AND session_id = ? AND item_key = ?")
      .get(hostId, sessionId, itemKey);
    return row ? toPending(row) : null;
  });
}

export function getPending(sessionId: string, hostId: string, itemKey: string, registrationId?: string): PendingUpdate | null {
  const d = db();
  const select = d.prepare<PendingRow, [string, string, string, string | null, string | null]>(
    "SELECT entry_id, message, cursor_json, final, batches_json, batch_index FROM pending p WHERE p.host_id = ? AND p.session_id = ? AND p.item_key = ? AND (? IS NULL OR EXISTS (SELECT 1 FROM watches w WHERE w.host_id = p.host_id AND w.session_id = p.session_id AND w.item_key = p.item_key AND w.registration_id = ?))",
  );
  const registration = registrationId ?? null;
  const row = select.get(hostId, sessionId, itemKey, registration, registration);
  if (!row) return null;
  if (row.batches_json !== "[]") return toPending(row);

  return transaction(d, () => {
    const current = select.get(hostId, sessionId, itemKey, registration, registration);
    if (!current) return null;
    if (current.batches_json !== "[]") return toPending(current);
    const batchesJson = JSON.stringify([{ entryId: current.entry_id, message: current.message }]);
    const { changes } = d
      .prepare("UPDATE pending SET batches_json = ?, batch_index = 0 WHERE host_id = ? AND session_id = ? AND item_key = ? AND entry_id = ? AND batches_json = '[]'")
      .run(batchesJson, hostId, sessionId, itemKey, current.entry_id);
    if (!changes) {
      const refreshed = select.get(hostId, sessionId, itemKey, registration, registration);
      return refreshed ? toPending(refreshed) : null;
    }
    return toPending({ ...current, batches_json: batchesJson, batch_index: 0 });
  });
}

/** One SQLite snapshot of every current pending batch that has not yet been acknowledged. */
export function pendingBatchEntryIds(): Set<string> {
  const rows = db().prepare<{ entry_id: string }, []>(
    `SELECT p.entry_id AS entry_id
       FROM watches w JOIN pending p USING (host_id, session_id, item_key)
      WHERE p.batches_json = '[]'
     UNION ALL
     SELECT json_extract(batch.value, '$.entryId') AS entry_id
       FROM watches w JOIN pending p USING (host_id, session_id, item_key)
       JOIN json_each(p.batches_json) AS batch
      WHERE CAST(batch.key AS INTEGER) >= p.batch_index`,
  ).all();
  return new Set(rows.map((row) => row.entry_id));
}

// ---------------------------------------------------------------- posted comments

/** Keeps a shared lease until the post id is recorded; expired leases only cover a crashed/stalled process. */
export async function whilePosting<T>(itemKey: string, post: () => Promise<T>): Promise<T> {
  const d = db();
  const token = randomUUID();
  transaction(d, () => {
    const now = Date.now();
    d.prepare("DELETE FROM active_posts WHERE lease_until <= ?").run(now);
    d.prepare("INSERT INTO active_posts (item_key, token, lease_until) VALUES (?, ?, ?)").run(itemKey, token, now + POST_LEASE_MS);
  });
  const renew = setInterval(() => {
    try {
      d.prepare("UPDATE active_posts SET lease_until = ? WHERE item_key = ? AND token = ?").run(Date.now() + POST_LEASE_MS, itemKey, token);
    } catch (error) {
      console.warn(`[tau] github watcher: post lease renewal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, POST_RENEW_MS);
  renew.unref?.();
  let completed = false;
  try {
    const result = await post();
    completed = true;
    return result;
  } finally {
    clearInterval(renew);
    // A thrown callback has an uncertain write outcome; keep it fenced until lease expiry.
    if (completed) {
      try {
        d.prepare("DELETE FROM active_posts WHERE item_key = ? AND token = ?").run(itemKey, token);
      } catch (error) {
        console.warn(`[tau] github watcher: post lease release failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export function isPosting(itemKey: string): boolean {
  return db().prepare("SELECT 1 FROM active_posts WHERE item_key = ? AND lease_until > ? LIMIT 1").get(itemKey, Date.now()) !== null;
}

/** The active lease keeps snapshot claims fenced until this ID is visible to every watcher connection. */
export function recordPosted(itemKey: string, commentId: string): void {
  db().prepare("INSERT OR IGNORE INTO posted (item_key, comment_id) VALUES (?, ?)").run(itemKey, commentId);
}

export function postedIds(itemKey: string): Set<string> {
  return new Set(
    db()
      .prepare<{ comment_id: string }, [string]>("SELECT comment_id FROM posted WHERE item_key = ?")
      .all(itemKey)
      .map((row) => row.comment_id),
  );
}

// ---------------------------------------------------------------- read grants

export function hasReadGrant(sessionId: string, hostId: string, repoKey: string): boolean {
  return db().prepare("SELECT 1 FROM read_grants WHERE host_id = ? AND session_id = ? AND repo_key = ?").get(hostId, sessionId, repoKey) !== null;
}

export function grantRead(sessionId: string, hostId: string, repoKey: string): void {
  db().prepare("INSERT OR IGNORE INTO read_grants (host_id, session_id, repo_key) VALUES (?, ?, ?)").run(hostId, sessionId, repoKey);
}

