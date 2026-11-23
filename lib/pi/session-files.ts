import { randomUUID } from "crypto";
import type { Dirent } from "fs";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  lstatSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import * as fsRuntime from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { gunzipSync, gzipSync } from "zlib";
import { isRecord } from "../type-guards";

// Keep user-session directory traversal out of Next's static NFT globbing.
// These paths are resolved and authorized at request time by tau.
const readDirectorySyncRuntime = Reflect.get(fsRuntime, "readdirSync") as typeof readdirSync;
import type {
  CompactionEntry,
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from "../types";
import { getArchivedSessionsDir, getSessionsDir } from "./paths";
import { sessionPathKey } from "../paths";

/**
 * Pure-Node reader/writer for pi's session JSONL files (format v3), so the
 * daemon can list and read sessions without starting pi.
 *
 * File layout: the {"type":"session"} header line, then entries forming a tree
 * via (id, parentId). pi refuses a file whose first entry is not the header.
 * Legacy v1/v2 files are migrated in memory on load. A session's name is the
 * latest `session_info` entry's (pi's appendSessionInfo; an empty name clears it).
 */

export const CURRENT_SESSION_VERSION = 3;

/** How pi serializes a session_info line (JSON.stringify of `{type, id, ...}`). */
const SESSION_INFO_LINE_PREFIX = '{"type":"session_info"';

/** The name a session_info record sets, as pi's getSessionName reads it. */
function sessionInfoName(record: { name?: unknown }): string | undefined {
  return typeof record.name === "string" ? record.name.trim() || undefined : undefined;
}

/** The session name: the latest session_info entry's, or undefined. */
export function sessionNameFromEntries(entries: ReadonlyArray<{ type?: string; name?: unknown }>): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "session_info") return sessionInfoName(entries[i]);
  }
  return undefined;
}

// ============================================================================
// Lenient JSONL parsing + migrations
// ============================================================================

/** JSON.stringify never emits raw newlines, so line splitting is a faithful
 * lenient JSONL parse: malformed/truncated lines are skipped, not fatal. */
export function parseJsonlLenient<T>(body: string): T[] {
  const out: T[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip malformed line (torn write, prefix-window truncation).
    }
  }
  return out;
}

type MutableEntry = SessionEntry & Record<string, unknown>;

function generateEntryId(taken: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(-8);
    if (!taken.has(id)) return id;
  }
  return randomUUID();
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(header: SessionHeader, entries: MutableEntry[]): void {
  header.version = 2;
  const ids = new Set<string>();
  let prevId: string | null = null;
  for (const entry of entries) {
    entry.id = generateEntryId(ids);
    ids.add(entry.id);
    entry.parentId = prevId;
    prevId = entry.id;
    if (entry.type === "compaction" && typeof entry.firstKeptEntryIndex === "number") {
      // firstKeptEntryIndex counts within the physical file entries, where the
      // header occupies index 0 (pi migrates over the combined array).
      const target = entry.firstKeptEntryIndex >= 1 ? entries[entry.firstKeptEntryIndex - 1] : undefined;
      if (target) (entry as CompactionEntry).firstKeptEntryId = target.id;
      delete entry.firstKeptEntryIndex;
    }
  }
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(header: SessionHeader, entries: MutableEntry[]): void {
  header.version = 3;
  for (const entry of entries) {
    if (entry.type === "message") {
      // Imports and hand-edits can produce message entries whose message
      // object is missing — entryToUiMessage tolerates that, so must we.
      const message = entry.message as { role?: string } | null | undefined;
      if (message?.role === "hookMessage") message.role = "custom";
    }
  }
}

function migrateToCurrentVersion(header: SessionHeader, entries: MutableEntry[]): void {
  const version = header.version ?? 1;
  if (version >= CURRENT_SESSION_VERSION) return;
  if (version < 2) migrateV1ToV2(header, entries);
  if (version < 3) migrateV2ToV3(header, entries);
}

// ============================================================================
// Session file loading
// ============================================================================

export type SessionLoadError = "too_large";

export interface LoadedSession {
  header: SessionHeader | null;
  entries: SessionEntry[];
  /** Set when the file exists but could not be materialized (see loadSessionFile). */
  error?: SessionLoadError;
}

export interface LoadSessionOptions {
  /** Retain only an entry's indexing metadata while scanning. Runs before
   * legacy migration; byte ranges exclude LF but include any CR. */
  projectEntry?: (entry: SessionEntry, offset: number, length: number) => SessionEntry;
}

const SESSION_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Ceiling on the on-disk size tau will materialize into memory. It is not a
 * pi limit — it is the point past which parsing a
 * session into JS objects (and serializing it into one HTTP response) would OOM
 * the whole server. Refusing loudly beats taking the process down.
 */
export const MAX_SESSION_LOAD_BYTES = 1024 * 1024 * 1024;

/**
 * Read a file line by line over a byte buffer. Unlike readFileSync(path,"utf8")
 * this never materializes the whole file as a single JS string, so sessions
 * past Node's ~512 MiB string cap still open. Lines exclude the newline; the
 * decoder carries multi-byte characters across chunk boundaries. Returning
 * false from onLine stops the read. `from` starts the read at that byte offset.
 */
export function forEachFileLineSync(
  filePath: string,
  onLine: (line: string, offset: number, length: number) => boolean | void,
  from = 0,
): void {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(SESSION_READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    // Join a long line only once; offsets count physical bytes, not UTF-16.
    const fragments: string[] = [];
    let offset = from;
    // null reads on from the file position, which starts at 0.
    let position: number | null = from || null;
    let length = 0;
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      if (position !== null) position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
        fragments.push(decoder.write(buffer.subarray(start, end)));
        length += end - start;
        if (end < bytesRead) {
          fragments.push(decoder.end());
          if (onLine(fragments.join(""), offset, length) === false) return;
          fragments.length = 0;
          offset += length + 1;
          length = 0;
        }
        start = end + 1;
      }
    }
    if (length > 0) {
      fragments.push(decoder.end());
      onLine(fragments.join(""), offset, length);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Load and parse a session file: validate the header, migrate legacy pi v1/v2
 * shapes and set header.title to the session name (latest session_info).
 * Missing/malformed files yield
 * { header: null, entries: [] } instead of throwing; a session too large to
 * hold in memory additionally sets error:"too_large" so routes can say so
 * instead of reporting it as malformed.
 */
export function loadSessionFile(filePath: string, options: LoadSessionOptions = {}): LoadedSession {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { header: null, entries: [] };
  }
  if (size > MAX_SESSION_LOAD_BYTES) {
    return { header: null, entries: [], error: "too_large" };
  }

  const records: Record<string, unknown>[] = [];
  let name: string | undefined;
  try {
    forEachFileLineSync(filePath, (rawLine, offset, length) => {
      const line = rawLine.trim();
      if (!line) return;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // Skip malformed line (torn write).
      }
      if (record?.type === "session_info") name = sessionInfoName(record);
      records.push(records.length > 0 && record && record.type !== "session" && options.projectEntry
        ? options.projectEntry(record as unknown as SessionEntry, offset, length) as unknown as Record<string, unknown>
        : record);
    });
  } catch (error) {
    // A single line past the string cap, or an allocation failure part-way in.
    const tooLarge = error instanceof RangeError;
    return { header: null, entries: [], ...(tooLarge ? { error: "too_large" as const } : {}) };
  }

  const headerRecord = records[0];
  if (!headerRecord || headerRecord.type !== "session" || typeof headerRecord.id !== "string") {
    return { header: null, entries: [] };
  }
  const header = headerRecord as unknown as SessionHeader;
  const entries = records.slice(1).filter((record) => record.type !== "session") as unknown as MutableEntry[];

  migrateToCurrentVersion(header, entries);

  if (name) header.title = name;
  else delete header.title;

  return { header, entries };
}

/** Bounded header read: parses only the first physical line, capped at 64 KiB. The header carries no name. */
export function readSessionHeaderSync(filePath: string, strict = false): SessionHeader | null {
  const maxHeaderBytes = 64 * 1024;
  if (strict && !lstatSync(path.dirname(filePath)).isDirectory()) throw new Error(`Cannot inventory symlinked session project at ${filePath}`);
  const expected = strict ? lstatSync(filePath, { bigint: true }) : null;
  if (expected && !expected.isFile()) throw new Error(`Cannot inventory non-regular session path ${filePath}`);
  let fd: number;
  try {
    fd = openSync(filePath, strict ? fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) : "r");
  } catch (error) {
    if (strict) throw error;
    return null;
  }
  let head: string;
  try {
    if (expected) {
      const opened = fstatSync(fd, { bigint: true });
      const current = lstatSync(filePath, { bigint: true });
      if (!lstatSync(path.dirname(filePath)).isDirectory()) throw new Error(`Session project changed during strict discovery: ${filePath}`);
      if (!current.isFile() || expected.dev !== opened.dev || expected.ino !== opened.ino
        || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Error(`Session path changed during strict discovery: ${filePath}`);
      }
    }
    const buffer = Buffer.allocUnsafe(maxHeaderBytes);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }

  let firstLineEnd = head.indexOf("\n");
  if (firstLineEnd === -1) {
    if (Buffer.byteLength(head, "utf8") >= maxHeaderBytes) return null;
    firstLineEnd = head.length;
  }
  const headerLine = head.slice(0, firstLineEnd).trim();
  if (!headerLine) return null;

  let header: SessionHeader;
  try {
    header = JSON.parse(headerLine) as SessionHeader;
  } catch {
    return null;
  }
  if (header.type !== "session") return null;
  delete header.title;
  return header;
}

// ============================================================================
// Tree + leaf helpers
// ============================================================================

/**
 * Build the session tree: one root for a well-formed session, orphaned entries
 * (broken parent chain) become extra roots. Labels come from label entries in
 * append order (a later label overrides; an empty label clears).
 */
export function buildSessionTree(entries: SessionEntry[]): SessionTreeNode[] {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (entry.label) labels.set(entry.targetId, entry.label);
    else labels.delete(entry.targetId);
  }

  const nodes = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    nodes.set(entry.id, { entry, children: [], label: labels.get(entry.id) });
  }
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const byTimestamp = (a: SessionTreeNode, b: SessionTreeNode) =>
    new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort(byTimestamp);
    stack.push(...node.children);
  }
  return roots;
}

/** The persisted leaf: the last appended entry (matches pi's loaded-session leaf). */
export function getLeafEntryId(entries: SessionEntry[]): string | null {
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

// ============================================================================
// Session listing (port of session-listing.ts)
// ============================================================================

export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

export interface PiSessionInfo {
  path: string;
  id: string;
  cwd: string;
  /** The session name (latest session_info). */
  title?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  size: number;
  firstMessage: string;
  status?: SessionStatus;
  /** Timestamp of the last message entry in the tail window (when scanned with status). */
  lastMessageAt?: Date;
}

const SESSION_LIST_PREFIX_BYTES = 4096;
const SESSION_LIST_SUFFIX_BYTES = 32_768;

function decodeJsonStringFragment(value: string): string {
  const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
  try {
    return JSON.parse(`"${safeValue}"`) as string;
  } catch {
    return safeValue
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

/** Raw-text string-property scan used on the possibly-truncated prefix window. */
function extractStringProperty(source: string, name: string, startIndex = 0): string | undefined {
  const propertyIndex = source.indexOf(`"${name}"`, startIndex);
  if (propertyIndex === -1) return undefined;
  const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
  if (colonIndex === -1) return undefined;

  let valueIndex = colonIndex + 1;
  while (valueIndex < source.length) {
    const char = source.charCodeAt(valueIndex);
    if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
    valueIndex++;
  }
  if (source.charCodeAt(valueIndex) !== 34) return undefined;

  const valueStart = valueIndex + 1;
  let escaped = false;
  for (let i = valueStart; i < source.length; i++) {
    const char = source.charCodeAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === 92) {
      escaped = true;
      continue;
    }
    if (char === 34) {
      return decodeJsonStringFragment(source.slice(valueStart, i));
    }
  }
  return decodeJsonStringFragment(source.slice(valueStart));
}

function countMessageMarkers(content: string): number {
  let count = 0;
  let index = 0;
  while (index < content.length) {
    const typeIndex = content.indexOf('"type"', index);
    if (typeIndex === -1) break;
    const colonIndex = content.indexOf(":", typeIndex + 6);
    if (colonIndex === -1) break;
    if (extractStringProperty(content, "type", typeIndex) === "message") count++;
    index = colonIndex + 1;
  }
  return count;
}

function extractFirstDisplayMessageFromPrefix(content: string): string | undefined {
  let fallback: string | undefined;
  let index = content.indexOf('"role"');
  while (index !== -1) {
    const role = extractStringProperty(content, "role", index);
    const text = extractStringProperty(content, "content", index) ?? extractStringProperty(content, "text", index);
    if (text) {
      if (role === "user") return text;
      if (!fallback && (role === "developer" || role === "assistant")) fallback = text;
    }
    index = content.indexOf('"role"', index + 6);
  }
  return fallback;
}

// Injected context (rules, skills, memory recall) can push the first user
// message past the 4 KiB prefix; stream lines until one turns up.
function scanFirstUserMessage(filePath: string): string {
  let text = "";
  try {
    forEachFileLineSync(filePath, (line) => {
      if (!line.includes('"user"') && !line.includes('"skill-prompt"')) return;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          customType?: string;
          content?: unknown;
          message?: { role?: string; content?: unknown };
        };
        if (entry.type === "message" && entry.message?.role === "user") {
          text = extractTextFromContent(entry.message.content);
          return !text;
        }
        if (entry.type === "custom_message" && entry.customType === "skill-prompt") {
          const content = typeof entry.content === "string" ? entry.content : "";
          const parts = content.split(/\nUser:\s*/);
          if (parts.length > 1 && parts[parts.length - 1].trim()) {
            text = parts[parts.length - 1].trim();
            return !text;
          }
          const skillMatch = /User invoked the "([^"]+)" skill/.exec(content);
          if (skillMatch && skillMatch[1]) {
            text = `Skill: ${skillMatch[1]}`;
            return !text;
          }
        }
      } catch {
        // Torn or hand-edited line: skip it, as parseJsonlLenient does.
      }
    });
  } catch {
    // A line past the JS string cap: keep listing the session without a first message.
  }
  return text;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") text.push(block.text);
  }
  return text.join(" ");
}

interface TailMessage {
  role?: string;
  stopReason?: string;
  content?: unknown;
}

function statusFromTailMessage(message: TailMessage): SessionStatus {
  switch (message.role) {
    case "assistant": {
      switch (message.stopReason) {
        case "error":
          return "error";
        case "aborted":
          return "aborted";
        case "length":
          return "interrupted";
      }
      const content = message.content;
      if (Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "toolCall")) {
        return "interrupted";
      }
      return "complete";
    }
    case "toolResult":
      return "interrupted";
    case "user":
      return "pending";
    default:
      return "unknown";
  }
}

/** The tail window's last message entry: lifecycle status plus its timestamp. */
function scanTailMessage(suffix: string): { status: SessionStatus; lastMessageAt?: Date } {
  if (!suffix) return { status: "unknown" };
  const lines = suffix.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Every persisted entry starts with "{" — cheaply skips blank lines and
    // the leading partial fragment of the tail window.
    if (line.charCodeAt(0) !== 123) continue;
    let entry: { type?: string; timestamp?: unknown; message?: TailMessage };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "message" && entry.message) {
      const at = typeof entry.timestamp === "string" ? new Date(entry.timestamp) : undefined;
      return { status: statusFromTailMessage(entry.message), lastMessageAt: at && !Number.isNaN(at.getTime()) ? at : undefined };
    }
  }
  return { status: "unknown" };
}

interface SessionListHeader {
  id: string;
  cwd?: string;
  parentSession?: string;
  timestamp?: string;
}

/** Parse the header from the prefix window. Falls back to a raw-text scan when
 * the header line straddles the window. */
function parseSessionListHeader(
  content: string,
  entries: Array<Record<string, unknown>>,
): SessionListHeader | undefined {
  const record = entries[0];
  if (record?.type === "session" && typeof record.id === "string") {
    return {
      id: record.id,
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
      timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
    };
  }
  const line = content.split(/\r?\n/).find((rawLine) => rawLine.trim())?.trim();
  if (!line || extractStringProperty(line, "type") !== "session") return undefined;
  const id = extractStringProperty(line, "id");
  if (!id) return undefined;
  return {
    id,
    cwd: extractStringProperty(line, "cwd"),
    parentSession: extractStringProperty(line, "parentSession"),
    timestamp: extractStringProperty(line, "timestamp"),
  };
}

/** The latest session_info name in the file from byte `from` (a line start) on, else `previous`. */
function scanSessionName(filePath: string, from: number, previous: string | undefined): string | undefined {
  let name = previous;
  try {
    forEachFileLineSync(filePath, (line) => {
      if (!line.startsWith(SESSION_INFO_LINE_PREFIX)) return;
      try {
        name = sessionInfoName(JSON.parse(line) as { name?: unknown });
      } catch {
        // Torn line: pi skips it too.
      }
    }, from);
  } catch {
    // A line past the JS string cap: keep what was found.
  }
  return name;
}

function readTextSlices(
  filePath: string,
  prefixBytes: number,
  suffixBytes: number,
  knownStat?: { size: number; mtime: Date },
): [string, string, number, Date] {
  const stat = knownStat ?? statSync(filePath);
  const fd = openSync(filePath, "r");
  try {
    const prefixLength = Math.min(prefixBytes, stat.size);
    const prefixBuffer = Buffer.allocUnsafe(prefixLength);
    const prefixRead = prefixLength > 0 ? readSync(fd, prefixBuffer, 0, prefixLength, 0) : 0;
    const prefix = prefixBuffer.subarray(0, prefixRead).toString("utf8");

    let suffix = "";
    if (suffixBytes > 0 && stat.size > 0) {
      const suffixLength = Math.min(suffixBytes, stat.size);
      const suffixBuffer = Buffer.allocUnsafe(suffixLength);
      const suffixRead = readSync(fd, suffixBuffer, 0, suffixLength, stat.size - suffixLength);
      suffix = suffixBuffer.subarray(0, suffixRead).toString("utf8");
    }
    return [prefix, suffix, stat.size, stat.mtime];
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan a single session file into an PiSessionInfo using only a 4 KiB prefix
 * window (plus a 32 KiB tail window when `withStatus` is set) — messageCount is
 * a prefix-derived lower bound — and a line scan for the session name. `nameFrom`
 * resumes that scan at an earlier size of the same file, keeping its name.
 */
export function scanSessionInfo(
  filePath: string,
  withStatus = true,
  knownStat?: { size: number; mtime: Date },
  nameFrom?: { offset: number; name: string | undefined },
): PiSessionInfo | undefined {
  try {
    const [content, suffix, size, mtime] = readTextSlices(
      filePath,
      SESSION_LIST_PREFIX_BYTES,
      withStatus ? SESSION_LIST_SUFFIX_BYTES : 0,
      knownStat,
    );
    const entries = parseJsonlLenient<Record<string, unknown>>(content);
    const header = parseSessionListHeader(content, entries);
    if (!header) return undefined;

    let parsedMessageCount = 0;
    let firstMessage = "";
    for (let i = 1; i < entries.length; i++) {
      const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry.type === "message" && entry.message) {
        parsedMessageCount++;
        if (entry.message.role === "user" && !firstMessage) {
          firstMessage = extractTextFromContent(entry.message.content);
        }
      }
    }

    // Cap at the prefix size: the list ships firstMessage for every session.
    // Files past the load ceiling cannot be opened anyway, so skip reading them.
    if (!firstMessage && size > SESSION_LIST_PREFIX_BYTES && size <= MAX_SESSION_LOAD_BYTES) {
      firstMessage = scanFirstUserMessage(filePath).slice(0, SESSION_LIST_PREFIX_BYTES);
    }
    firstMessage ||= extractFirstDisplayMessageFromPrefix(content) ?? "";
    const messageCount = Math.max(parsedMessageCount, countMessageMarkers(content));
    const tail = withStatus ? scanTailMessage(suffix) : undefined;
    const name = scanSessionName(filePath, nameFrom?.offset ?? 0, nameFrom?.name);
    return {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      title: name,
      parentSessionPath: header.parentSession,
      created: new Date(header.timestamp ?? ""),
      modified: mtime,
      messageCount,
      size,
      firstMessage: firstMessage || "(no messages)",
      status: tail?.status,
      lastMessageAt: tail?.lastMessageAt,
    };
  } catch {
    return undefined;
  }
}

// Memo of per-file scan results keyed by (size, mtimeMs). The session list
// cache is invalidated after every agent turn/rename/model change, so full
// rescans are frequent; the memo turns each UNCHANGED file's prefix+suffix
// window reads into a single stat. (path, size, mtimeMs) covers every session
// mutation tau cares about. Stored on globalThis for hot-reload safety and
// LRU-bounded (Map iteration order doubles as recency order).
interface SessionScanCacheEntry {
  size: number;
  mtimeMs: number;
  info: PiSessionInfo;
}

declare global {
  var __tauSessionScanCache: Map<string, SessionScanCacheEntry> | undefined;
}

const MAX_SESSION_SCAN_CACHE_ENTRIES = 2048;

/** Normalized cache key: sessionPathKey lowercases and normalizes separators
 * on Windows so invalidation from a differently-cased path still hits. */
function scanCacheKey(filePath: string): string {
  return sessionPathKey(filePath);
}

function getSessionScanCache(): Map<string, SessionScanCacheEntry> {
  if (!globalThis.__tauSessionScanCache) globalThis.__tauSessionScanCache = new Map();
  return globalThis.__tauSessionScanCache;
}

/** Invalidate the memoized scan (prefix/suffix window info) for ONE session
 * file. Callers that know exactly which session changed (live RPC events with
 * a session file path, the file watcher with a concrete filename) use this
 * when the file's size+mtime may NOT have changed (reparent rewrites,
 * delete-while-open) so the list scan picks up the new window without
 * dropping every other session's scan memo. */
export function invalidateSessionScanCache(filePath: string): void {
  globalThis.__tauSessionScanCache?.delete(scanCacheKey(filePath));
}

/** Clear EVERY per-file scan memo. Used by the full list-cache flush for
 * unknown-source changes (delete/archive/import fallbacks): a change whose
 * path is unknown cannot target one memo, and without this an unknown
 * same-size + same-mtime rewrite would keep serving the OLD scan summary
 * (old title / old parent link) to the sidebar. */
export function invalidateAllSessionScanCaches(): void {
  globalThis.__tauSessionScanCache?.clear();
}

/** scanSessionInfo memoized on (path, size, mtimeMs). Callers must treat the
 * returned info as immutable — cache hits share one object. */
export function scanSessionInfoCached(filePath: string): PiSessionInfo | undefined {
  let stat: { size: number; mtime: Date; mtimeMs: number };
  try {
    stat = statSync(filePath);
  } catch {
    return undefined;
  }
  const cache = getSessionScanCache();
  const key = scanCacheKey(filePath);
  const cached = cache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.info;
  }
  if (cached) cache.delete(key);
  // pi only appends: a grown file needs the name scan only past the old end.
  const nameFrom = cached && stat.size > cached.size ? { offset: cached.size, name: cached.info.title } : undefined;
  const info = scanSessionInfo(filePath, true, stat, nameFrom);
  // Failed scans are not negatively cached: a transient read error must not
  // hide a session until its next mtime bump.
  if (info) {
    cache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, info });
    while (cache.size > MAX_SESSION_SCAN_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  }
  return info;
}

/**
 * List all sessions across all project subdirectories (newest first). Only
 * `<sessionsDir>/<projectDir>/*.jsonl` files are scanned — per-session
 * artifacts directories (session file name minus .jsonl) are skipped because
 * the walk only descends one level and only accepts regular files.
 *
 * The directory walk itself is cached on the sessions root's mtimeMs: creating
 * or deleting any session changes that parent directory's mtime, so the cache
 * invalidates for free on every add/remove while turning repeated listing
 * requests (sidebar poll, page loads) into a single stat. Per-file scanning is
 * still memoized by scanSessionInfoCached on (size, mtimeMs).
 */
export async function listAllSessionInfos(): Promise<PiSessionInfo[]> {
  const sessionsRoot = getSessionsDir();
  const files = await listSessionFiles(sessionsRoot);

  const sessions: PiSessionInfo[] = [];
  for (const file of files) {
    const info = scanSessionInfoCached(file);
    if (info) sessions.push(info);
  }
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

interface SessionFileListCacheEntry {
  rootMtimeMs: number;
  subMaxMtimeMs: number;
  files: string[];
}

declare global {
  var __tauSessionFileListCache: Map<string, SessionFileListCacheEntry> | undefined;
}

/** Cached walk of `<sessionsRoot>/<project>/*.jsonl`, keyed on the root's
 * mtimeMs. Adding/removing a session bumps the root's mtime, invalidating
 * automatically — except on filesystems where a write inside a project
 * subdirectory does not touch the parent directory's mtime (Windows/NTFS
 * behaves this way in some configurations). Callers that know a session
 * changed must therefore also call invalidateSessionFileListCache(). */
export function invalidateSessionFileListCache(): void {
  globalThis.__tauSessionFileListCache?.clear();
}

export async function listSessionFiles(sessionsRoot: string): Promise<string[]> {
  let rootStat: { mtimeMs: number };
  try {
    rootStat = statSync(sessionsRoot);
  } catch {
    return [];
  }
  if (!globalThis.__tauSessionFileListCache) globalThis.__tauSessionFileListCache = new Map();
  const cache = globalThis.__tauSessionFileListCache;
  const cached = cache.get(sessionsRoot);
  if (cached && cached.rootMtimeMs === rootStat.mtimeMs) {
    // Windows/NTFS: root mtime may not bump when a file is added inside a project subdir.
    // Validate by sampling subdir mtimes (cheap: stat per project dir, not per file).
    let stale = false;
    try {
      for (const dirent of readDirectorySyncRuntime(sessionsRoot, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const subPath = path.join(sessionsRoot, dirent.name);
        const subMtime = statSync(subPath).mtimeMs;
        if (subMtime > cached.subMaxMtimeMs) { stale = true; break; }
      }
    } catch { stale = true; }
    if (!stale) return cached.files;
  }

  const files = collectSessionFiles(sessionsRoot);
  // Remember the root mtime separately from the sampled subdir max: comparing
  // the combined max against the current root mtime never matches once any
  // subdir outgrows the root (the normal NTFS steady state), defeating the cache.
  let subMaxMtimeMs = 0;
  try {
    for (const dirent of readDirectorySyncRuntime(sessionsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      subMaxMtimeMs = Math.max(subMaxMtimeMs, statSync(path.join(sessionsRoot, dirent.name)).mtimeMs);
    }
  } catch {}
  cache.set(sessionsRoot, { rootMtimeMs: rootStat.mtimeMs, subMaxMtimeMs, files });
  return files;
}

/** Restore conflict preflight only: an uncached, complete ID inventory. Never populate or trust the best-effort sidebar
 * caches: skipped directories or unreadable/unidentifiable headers cannot prove a session absent on this machine. */
export function listSessionIdsForRestore(sessionsRoot = getSessionsDir()): string[] {
  const ids: string[] = [];
  for (const file of collectSessionFiles(sessionsRoot, true)) {
    const header = readSessionHeaderSync(file, true);
    if (!header || typeof header.id !== "string" || !header.id) throw new Error(`Cannot identify active session at ${file}`);
    ids.push(header.id);
  }
  return ids;
}

function collectSessionFiles(sessionsRoot: string, strict = false): string[] {
  const files: string[] = [];
  let projects: Dirent[];
  let observedRoot = false;
  try {
    if (strict) {
      const root = lstatSync(sessionsRoot);
      observedRoot = true;
      if (!root.isDirectory()) throw new Error(`Cannot inventory non-directory sessions root ${sessionsRoot}`);
    }
    projects = readDirectorySyncRuntime(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    // Only a root absent from the outset is an empty inventory. Once observed, disappearance is uncertainty.
    if (strict && (observedRoot || !(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))) throw error;
    return [];
  }
  for (const dirent of projects) {
    const dirPath = path.join(sessionsRoot, dirent.name);
    if (strict && dirent.isSymbolicLink()) throw new Error(`Cannot inventory symlinked session project ${dirPath}`);
    if (!dirent.isDirectory()) continue;
    let inner: Dirent[];
    try {
      if (strict && !lstatSync(dirPath).isDirectory()) throw new Error(`Session project changed during strict discovery: ${dirPath}`);
      inner = readDirectorySyncRuntime(dirPath, { withFileTypes: true });
    } catch (error) {
      // This project was enumerated: even ENOENT may mean it was renamed with active sessions inside. Never skip it in preflight.
      if (strict) throw error;
      continue;
    }
    for (const file of inner) {
      if (strict && file.isSymbolicLink() && file.name.endsWith(".jsonl")) {
        throw new Error(`Cannot inventory symlinked session file ${path.join(dirPath, file.name)}`);
      }
      if (file.isFile() && file.name.endsWith(".jsonl")) files.push(path.join(dirPath, file.name));
    }
  }
  return files;
}

// ============================================================================
// Title updates + deletion
// ============================================================================

/** Strip control characters and collapse runs of spaces. */
export function cleanSessionTitle(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** The id of the file's last entry (pi's leaf on load), or null when it has none. */
function lastEntryId(filePath: string, size: number): string | null {
  const tailBytes = Math.min(size, 64 * 1024);
  const fd = openSync(filePath, "r");
  let tail: string;
  try {
    const buffer = Buffer.allocUnsafe(tailBytes);
    tail = buffer.toString("utf8", 0, readSync(fd, buffer, 0, tailBytes, size - tailBytes));
  } finally {
    closeSync(fd);
  }
  const lines = tail.split("\n");
  // The first tail line may be cut; a complete one ending the window still counts.
  for (let i = lines.length - 1; i >= (tailBytes < size ? 1 : 0); i--) {
    try {
      const record = JSON.parse(lines[i]) as { type?: unknown; id?: unknown };
      if (record.type !== "session" && typeof record.id === "string") return record.id;
      if (record.type === "session") return null;
    } catch {
      // Blank, torn or cut line.
    }
  }
  // Every line in the window was cut or torn (one huge entry): read the whole file.
  return loadSessionFile(filePath).entries.at(-1)?.id ?? null;
}

/**
 * Name a session that no pi process holds, as pi's appendSessionInfo does: one
 * `session_info` entry appended under the last entry (pi's leaf on load). A live
 * session is renamed through pi's `set_session_name` instead.
 */
export function setSessionTitle(filePath: string, title: string): boolean {
  const name = cleanSessionTitle(title);
  if (!name) return false;
  if (!readSessionHeaderSync(filePath)) throw new Error("Not a session file");
  const size = statSync(filePath).size;
  let endsWithNewline = true;
  const fd = openSync(filePath, "r");
  try {
    const last = Buffer.alloc(1);
    endsWithNewline = readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 10;
  } finally {
    closeSync(fd);
  }
  const entry = {
    type: "session_info",
    id: randomUUID().slice(0, 8),
    parentId: lastEntryId(filePath, size),
    timestamp: new Date().toISOString(),
    name,
  };
  appendFileSync(filePath, `${endsWithNewline ? "" : "\n"}${JSON.stringify(entry)}\n`);
  return true;
}

/**
 * Replace a session file's contents through a temp file in the same directory
 * plus renameSync. writeFileSync truncates before writing, so a crash or ENOSPC
 * mid-write would permanently destroy the session; rename is atomic, leaving
 * either the old or the new file.
 */
export function writeSessionFileAtomicSync(filePath: string, body: string, tag = "rewrite"): void {
  const dir = path.dirname(filePath);
  const tempDir = mkdtempSync(path.join(dir, `.tau-${tag}-`));
  const tempPath = path.join(tempDir, path.basename(filePath));
  try {
    writeFileSync(tempPath, body, "utf8");
    renameSync(tempPath, filePath);
  } finally {
    try {
      rmdirSync(tempDir);
    } catch {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export interface SessionArchiveRoots {
  /** Override the active sessions root for tests or an injected filesystem. */
  sessionsRoot?: string;
  /** Override the archive root for tests or an injected filesystem. */
  archiveRoot?: string;
}

/**
 * Archive one session: the JSONL is gzip-compressed below `<agent>/archive/sessions`, while its
 * sibling artifacts directory is moved alongside the compressed file. The
 * source file remains byte-for-byte unchanged until the compressed destination
 * is durably renamed; failures roll back both moves where possible.
 */
export function archiveSessionFileWithArtifacts(filePath: string, roots: SessionArchiveRoots = {}): string {
  const sessionsRoot = path.resolve(roots.sessionsRoot ?? getSessionsDir());
  const source = path.resolve(filePath);
  const relative = path.relative(sessionsRoot, source);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative) ||
    !relative.endsWith(".jsonl")
  ) {
    throw new Error("Session path is outside the active pi sessions directory");
  }
  if (!lstatSync(source).isFile()) throw new Error("Session path is not a regular file");

  const archiveRoot = path.resolve(roots.archiveRoot ?? getArchivedSessionsDir());
  const destination = path.join(archiveRoot, `${relative}.gz`);
  const legacyDestination = destination.slice(0, -3);
  if (existsSync(destination) || existsSync(legacyDestination)) {
    throw new Error("Archived session destination already exists");
  }

  const sourceArtifacts = source.slice(0, -".jsonl".length);
  // The archive layout keeps the `.jsonl` suffix on the artifacts
  // directory after appending `.gz` to the session file.
  const destinationArtifacts = destination.slice(0, -".gz".length);
  mkdirSync(path.dirname(destination), { recursive: true });
  const tempDir = mkdtempSync(path.join(path.dirname(destination), ".tau-archive-"));
  const tempCompressed = path.join(tempDir, path.basename(destination));
  const tempRestore = path.join(tempDir, path.basename(source));
  let destinationCreated = false;
  let sourceRemoved = false;
  let artifactsMoved = false;

  try {
    writeFileSync(tempCompressed, gzipSync(readFileSync(source), { level: 9 }));
    renameSync(tempCompressed, destination);
    destinationCreated = true;
    unlinkSync(source);
    sourceRemoved = true;

    if (existsSync(sourceArtifacts)) {
      if (existsSync(destinationArtifacts)) throw new Error("Archived session artifacts destination already exists");
      mkdirSync(path.dirname(destinationArtifacts), { recursive: true });
      renameSync(sourceArtifacts, destinationArtifacts);
      artifactsMoved = true;
    }
    return destination;
  } catch (error) {
    if (artifactsMoved) {
      try { renameSync(destinationArtifacts, sourceArtifacts); } catch { /* preserve original error */ }
    }
    // Restore the source if it was already removed. Only after the restore
    // SUCCEEDS is the archive safe to delete — if the restore fails, the
    // archive is the only copy of the session left, and deleting it would
    // lose both copies permanently.
    let restored = true; // nothing to restore unless the source was removed
    if (sourceRemoved && destinationCreated) {
      restored = false;
      try {
        writeFileSync(tempRestore, gunzipSync(readFileSync(destination)));
        mkdirSync(path.dirname(source), { recursive: true });
        renameSync(tempRestore, source);
        restored = true;
      } catch { /* preserve original error */ }
    }
    if (destinationCreated && restored) {
      try { unlinkSync(destination); } catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Delete a session file and its per-session artifacts directory (the sibling
 * directory named after the file minus ".jsonl", holding subagent transcripts).
 */
export function deleteSessionFileWithArtifacts(filePath: string): void {
  unlinkSync(filePath);
  if (!filePath.endsWith(".jsonl")) return;
  const artifactsDir = filePath.slice(0, -".jsonl".length);
  try {
    rmSync(artifactsDir, { recursive: true, force: true });
  } catch {
    // The session file itself is already gone; artifact cleanup is best-effort.
  }
}

/**
 * Every transcript (`*.jsonl`, any depth) in a session's artifacts directory:
 * task subagents and their nested subagents, advisors (`__advisor*.jsonl`),
 * `/tan` clones and extension sub-sessions. Each records its own model usage.
 * The top-level `local/` folder is skipped: it holds composer uploads, never
 * transcripts, and can hold arbitrary trees. Returns [] without an
 * artifacts directory.
 */
export function listSessionArtifactTranscripts(sessionFile: string): string[] {
  if (!sessionFile.endsWith(".jsonl")) return [];
  const root = sessionFile.slice(0, -".jsonl".length);
  const transcripts: string[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readDirectorySyncRuntime(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir !== root || entry.name !== "local") pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        transcripts.push(entryPath);
      }
    }
  }
  return transcripts;
}
