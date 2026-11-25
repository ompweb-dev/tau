import { execFile } from "child_process";
import { promisify } from "util";
import type { Dirent } from "fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "path";
import { buildEntriesFromFiles, filterFileEntries, type FileIndexEntry } from "./file-fuzzy";
import { createGitEnvironment } from "./project-command-env";
import type { WorkspaceIndex, WorkspaceTextMatch, WorkspaceTextSearch } from "./workspace-types";
import { existingPathWithinRootsChecker, isPiSecretFile } from "./file-access";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { HostOpError } from "./hosts/link-protocol";
import { getAgentDir, getConfigRoot } from "./pi/paths";
const execFileAsync = promisify(execFile);


/** Cap on the plain (no-query) response used as the client-side index */
const MAX_FILES = 5000;
/** Hard caps on the full in-memory listing that ?q= searches against */
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const WALK_DIR_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface FileListing {
  /** Full listing up to the hard cap (not the client cap) */
  files: string[];
  /** True when even the hard cap was exceeded */
  hardTruncated: boolean;
}

interface CacheEntry {
  listing: FileListing;
  /** Derived lazily on the first ?q= search against this listing */
  entries?: FileIndexEntry[];
  /** Same, restricted to files, for callers that never show directories */
  fileEntries?: FileIndexEntry[];
  expiresAt: number;
}

// Per-cwd cache on globalThis so it survives a `bun --hot` re-evaluation; the @ menu
// re-requests on every open and searches on every keystroke, so listings must
// not be recomputed within a short window.
declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
  var __piFileIndexPending: Map<string, Promise<FileListing>> | undefined;
}

function getIndexCache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

/**
 * Build the listing for one cwd, collapsing concurrent callers onto the same
 * scan. Without this, several refreshes in flight would each run `git ls-files`
 * and the slowest one could overwrite a newer cache entry.
 */
function loadListing(cwd: string): Promise<FileListing> {
  if (!globalThis.__piFileIndexPending) globalThis.__piFileIndexPending = new Map();
  const pending = globalThis.__piFileIndexPending;
  const inFlight = pending.get(cwd);
  if (inFlight) return inFlight;
  const scan = (async () => (await listWithGit(cwd)) ?? listWithWalk(cwd))()
    .finally(() => { pending.delete(cwd); });
  pending.set(cwd, scan);
  return scan;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const gitOptions = {
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      env: createGitEnvironment({ LC_ALL: "C" }),
    };
    // --cached lists index entries, including files already removed from the
    // working tree. Those would show up as results that 404 the moment anyone
    // opens them, so subtract what git reports as deleted. That query is
    // auxiliary: a stale-but-complete listing beats throwing away the git
    // listing over it, which would fall back to the depth-capped readdir walk.
    // allSettled, not all: return only once both children have exited, since a
    // live `git -C cwd` keeps Windows from deleting or renaming cwd.
    const [listed, deleted] = await Promise.allSettled([
      execFileAsync("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], gitOptions),
      execFileAsync("git", ["-C", cwd, "ls-files", "--deleted", "-z"], gitOptions),
    ]);
    if (listed.status === "rejected") return null;
    const missing = new Set((deleted.status === "fulfilled" ? deleted.value.stdout : "").split("\0").filter(Boolean));
    const all = listed.value.stdout.split("\0").filter((file) => file && !missing.has(file));
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

async function listWithWalk(cwd: string): Promise<FileListing> {
  const files: string[] = [];
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  let head = 0;
  let hardTruncated = false;
  while (head < queue.length) {
    const { abs, rel, depth } = queue[head++]!;
    let dirents: Dirent[];
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      // Never follow symlinked directories out of cwd or into a loop.
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          // Bound the queue too, even when one directory has many empty children.
          if (queue.length < WALK_DIR_CAP) {
            queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
          } else {
            hardTruncated = true;
          }
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated };
}

/** The cwd's listing, from the cache while it is fresh. */
async function cachedListing(cwd: string, forceRefresh: boolean): Promise<CacheEntry> {
    const cache = getIndexCache();
    const now = Date.now();
    // An explicit refresh in the UI must not be answered from the TTL window,
    // or a file the agent just wrote stays invisible. loadListing collapses
    // concurrent rebuilds onto one scan, which is the whole bound: an age gate
    // on top of it can only suppress the refresh the user actually asked for.
    let cached = cache.get(cwd);
    if (!cached || cached.expiresAt <= now || forceRefresh) {
      const listing = await loadListing(cwd);
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
      }
      // Replacing an existing key does not grow the cache, so it must not wipe
      // the listings of unrelated projects.
      if (!cache.has(cwd) && cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      // Timed after the scan, not from `now`: a large repo can take longer to
      // list than the whole TTL, which would store an already-expired entry.
      cached = { listing, expiresAt: Date.now() + CACHE_TTL_MS };
      cache.set(cwd, cached);
    }
    return cached;
}

export async function indexWorkspaceFiles(cwd: string, query: string, limit: number, kind: "all" | "file", forceRefresh: boolean): Promise<WorkspaceIndex> {
    const cached = await cachedListing(cwd, forceRefresh);
    if (query) {
      cached.entries ??= buildEntriesFromFiles(cached.listing.files);
      // Directories score a ranking bonus, so a caller that only renders files
      // must drop them before the limit is applied: "api" in this repo matches
      // 67 directories, which would otherwise consume half the budget and
      // silently push matching files out of the response.
      if (kind === "file") {
        cached.fileEntries ??= cached.entries.filter((entry) => !entry.isDir);
        // Ask for one past the limit: the extra row never ships, it only tells
        // the panel that the list it shows is incomplete. A listing that hit the
        // hard cap is incomplete the same way, and is worth reporting even
        // though fewer than `limit` rows matched what survived.
        const ranked = filterFileEntries(cached.fileEntries, query, limit + 1);
        const truncated = ranked.length > limit || cached.listing.hardTruncated;
        return {
          matches: truncated ? ranked.slice(0, limit) : ranked,
          truncated,
        };
      }
      return { matches: filterFileEntries(cached.entries, query, limit) };
    }

    const { files, hardTruncated } = cached.listing;
    return {
      files: files.slice(0, MAX_FILES),
      truncated: hardTruncated || files.length > MAX_FILES,
    };
}

/** Most matches a text search answers. */
export const MAX_TEXT_MATCHES = 500;
/** Longest line excerpt a match carries. */
const TEXT_MATCH_EXCERPT = 240;
/** Tests shorten the budget. */
export const textSearchLimits = { budgetMs: 10_000 };
/** The newest search per cwd: an older one still scanning stops. */
const latestSearch = new Map<string, object>();

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** An excerpt of a long line (minified files) around its match, keeping the whole match where it fits. */
function excerpt(line: string, index: number, matched: number): Omit<WorkspaceTextMatch, "path" | "line"> {
  let start = 0;
  let end = line.length;
  if (line.length > TEXT_MATCH_EXCERPT) {
    start = Math.max(0, Math.min(index - Math.min(60, Math.max(0, TEXT_MATCH_EXCERPT - matched)), line.length - TEXT_MATCH_EXCERPT));
    if (start > 0 && isLowSurrogate(line.charCodeAt(start))) start++;
    end = Math.min(line.length, start + TEXT_MATCH_EXCERPT);
    if (end < line.length && isHighSurrogate(line.charCodeAt(end - 1))) end--;
  }
  const text = line.slice(start, end);
  const column = index - start;
  return { text, column, length: Math.min(matched, text.length - column) };
}

/**
 * Searches the text files of the cwd's listing (the file index: .gitignore
 * respected) for a literal string. Reads only regular files whose real path
 * stays inside the cwd, up to the preview size (what a result can open), and
 * skips binary files (a NUL in the first 8 KiB) and pi's credential files.
 * `truncated`: the match cap, the time budget, a newer search of the cwd or
 * the listing's cap stopped it.
 */
export async function searchWorkspaceText(cwd: string, query: string, caseSensitive: boolean): Promise<WorkspaceTextSearch> {
  const token = {};
  latestSearch.set(cwd, token);
  try {
    // Fresh: a search must see files written a moment ago.
    const { listing } = await cachedListing(cwd, true);
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "u" : "iu");
    // A parent directory swapped for a symlink still lists its old files, and lstat follows it.
    const inCwd = existingPathWithinRootsChecker(new Set([cwd]));
    const inAgentDir = existingPathWithinRootsChecker(new Set([getAgentDir(), path.join(getConfigRoot(), "agent")]));
    const matches: WorkspaceTextMatch[] = [];
    const deadline = Date.now() + textSearchLimits.budgetMs;
    for (const rel of listing.files) {
      if (matches.length > MAX_TEXT_MATCHES) break;
      if (Date.now() > deadline || latestSearch.get(cwd) !== token) return { cwd, matches: matches.slice(0, MAX_TEXT_MATCHES), truncated: true };
      const absolute = path.join(cwd, rel);
      let content: Buffer;
      try {
        const stat = await lstat(absolute);
        if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES || !inCwd(absolute)) continue;
        // The full credential check costs a directory read: only a hard link or a file in pi's agent directory can be one.
        if ((stat.nlink > 1 || inAgentDir(absolute)) && isPiSecretFile(absolute)) continue;
        content = await readFile(absolute);
      } catch (error) {
        // Unreadable credential metadata fails closed; any other unreadable path is skipped.
        if (error instanceof HostOpError && error.status === 503) throw error;
        continue;
      }
      if (content.subarray(0, 8192).includes(0)) continue;
      const lines = content.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length <= MAX_TEXT_MATCHES; index++) {
        const found = pattern.exec(lines[index]);
        if (found) matches.push({ path: rel, line: index + 1, ...excerpt(lines[index], found.index, found[0].length) });
      }
    }
    return { cwd, matches: matches.slice(0, MAX_TEXT_MATCHES), truncated: matches.length > MAX_TEXT_MATCHES || listing.hardTruncated };
  } finally {
    if (latestSearch.get(cwd) === token) latestSearch.delete(cwd);
  }
}
