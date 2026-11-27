import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "fs";
import { realpath } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { isUtf8 } from "node:buffer";
import { getAgentDir, getConfigRoot } from "./pi/paths";
import { isWindowsAbsolutePath } from "./paths";
import { hostSessions } from "./hosts/session-index";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { HostOpError } from "./hosts/link-protocol";

export { isWindowsAbsolutePath } from "./paths";


// Allowed roots — in-memory plus session-derived, globalThis for hot-reload.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
}

export function normalizeSlashes(filePath: string): string {
  return stripLongPathPrefix(filePath.replace(/\\/g, "/"));
}

/** Windows device paths (\\?\C:\... , \\?\UNC\server\share\...) come back from
 *  realpathSync and defeat plain startsWith prefix checks against ordinary
 *  drive/UNC roots, producing false 403s on long paths and junctions. */
function stripLongPathPrefix(filePath: string): string {
  if (filePath.startsWith("//?/UNC/")) return "//" + filePath.slice(8);
  if (filePath.startsWith("//?/")) return filePath.slice(4);
  if (filePath.startsWith("\\\\?\\UNC\\")) return "\\\\" + filePath.slice(8);
  if (filePath.startsWith("\\\\?\\")) return filePath.slice(4);
  return filePath;
}

function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) globalThis.__piAdditionalAllowedRoots = new Set();
  return globalThis.__piAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const n = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(n);
  globalThis.__piAllowedRootsCache?.roots.add(n);
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

/**
 * pi's own config/agent roots: the config root (`~/.pi`), the agent state dir (`~/.pi/agent`, or
 * `PI_CODING_AGENT_DIR`), and the ecosystem-standard agent rule/skill provider
 * dirs `~/.agents` and `~/.agent`. Global instruction files pi loads itself
 * (`~/.agents/AGENTS.md`, `~/.pi/agent/...`) used to 403 in the file viewer
 * because only workspaces were allowed roots (#135).
 *
 * Derived from lib/pi/paths.ts rather than re-implemented, so the
 * PI_CODING_AGENT_DIR rule stays in one place.
 * A directory that does not exist is harmless: isPathWithinRoots is a pure
 * string-prefix check and existingPathWithinRootsChecker() already swallows
 * realpathSync failures for stale roots.
 */
export function getConfigAgentRoots(): string[] {
  return [
    getConfigRoot(),
    getAgentDir(),
    path.join(homedir(), ".agents"),
    path.join(homedir(), ".agent"),
  ].map(normalizeSlashes);
}

/**
 * Secret files, which must stay unreadable through the generic file
 * API even though their directory is an allowed root (#135).
 *
 * pi's credential and secret files in an agent dir: `auth.json` (API keys and
 * OAuth tokens), `mcp-auth.json` (MCP OAuth tokens), the legacy `oauth.json`
 * (and the `oauth.json.migrated` pi leaves after moving it into `auth.json`),
 * `models.json` (a custom provider's `apiKey`/`headers`) and `mcp.json` (MCP
 * server `headers` and `env`). tau's `tau-settings.json` holds the agent
 * environment variables. They are reachable through their purpose-built routes
 * (`app/api/auth/api-key/*`, `app/api/models-config/route.ts`, `/api/mcp`,
 * `/api/web-settings`), which redact or scope what they return.
 *
 * Only direct files in an agent dir are denied, including credential copies
 * and editor swaps. tau's own state, `<agent dir>/tau/` (the session-signing
 * key, host tokens and their hashes, the VAPID private key, the outbox, cluster
 * copies of `models.json`), is denied as a whole tree.
 * Independent session uploads and package assets remain readable. Resolve both
 * the owned directories and their protected files: either can be symlinked.
 * Hard links retain distinct paths, so compare their device/inode identity too.
 */
export const PI_SECRET_NAME = /^\.?(?:(?:mcp-)?auth|oauth|models|mcp|tau-settings)\.json(?:[.~][\s\S]*|-(?:backup|bak|old)(?:[.~-][\s\S]*)?)?$/i;
const PI_SECRET_FILES = ["auth.json", "mcp-auth.json", "oauth.json", "models.json", "mcp.json", "tau-settings.json"];
/** tau's key files, checked by identity too: a hard link of one outside `tau/` is still that secret. */
const TAU_SECRET_FILES = ["web-auth-secret.json", "host.json", "hosts.json", "host-control.json",
  ...["notifications.db", "outbox.db"].flatMap((db) => [db, `${db}-wal`, `${db}-shm`, `${db}-journal`])];
/** pi configuration files a cluster member mirrors that hold credentials (`MIRRORED` in hosts/cluster-config.ts). */
const MIRRORED_SECRET_FILES = ["models.json", "mcp.json"];

/**
 * tau's copies of credential files: the member's own ones in `own-config/` (and its agent environment) and the staged
 * and replaced ones. A relative symlink moved into `own-config/` or `trash/` also names what it resolved to in the agent dir.
 */
export function tauCredentialCopies(agentDir: string, onUnavailable?: () => void): string[] {
  const tau = path.join(agentDir, "tau");
  const files = [path.join(tau, "own-config", "agent-env.json")];
  for (const name of MIRRORED_SECRET_FILES) {
    for (const dir of [path.join(tau, "own-config"), ...["stage", "trash"].map((d) => path.join(tau, "cluster-config", d))]) {
      files.push(path.join(dir, "agent", name));
    }
    // A relative link keeps its text when moved out of the agent dir (a member's own one, or one put live and then
    // replaced): resolve it against the agent dir.
    for (const moved of [path.join(tau, "own-config", "agent", name), path.join(tau, "cluster-config", "trash", "agent", name)]) {
      try {
        if (!lstatSync(moved).isSymbolicLink()) continue;
        const bytes = readlinkSync(moved, { encoding: "buffer" });
        if (!isUtf8(bytes)) { onUnavailable?.(); continue; }
        const link = bytes.toString("utf8");
        if (!path.isAbsolute(link)) files.push(joinWithoutNormalizing(resolvedOrSelf(agentDir, onUnavailable), link));
      } catch (error) { if (!isMissingPathError(error)) onUnavailable?.(); }
    }
  }
  return files;
}

/**
 * `dev:ino` of every downloaded cluster config object: tau-written, flat and bounded by the manifest. All of them,
 * not only the credential ones (the manifest would tell), so a hard link of a mirrored skill is denied too.
 */
export function clusterObjectIdentities(agentDir: string, onUnavailable?: () => void): Set<string> {
  const dir = path.join(agentDir, "tau", "cluster-config", "objects");
  const identities = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(dir); } catch (error) { if (!isMissingPathError(error)) onUnavailable?.(); }
  for (const name of names) {
    try { const info = lstatSync(path.join(dir, name), { bigint: true }); identities.add(`${info.dev}:${info.ino}`); }
    catch (error) { if (!isMissingPathError(error)) onUnavailable?.(); }
  }
  return identities;
}
const credentialPolicyUnavailable = () => new HostOpError(503, "credential_policy_unavailable", "Credential exclusions cannot be verified while their filesystem metadata is unreadable");

/** Request metadata failures retain a 404; incomplete credential ownership metadata throws a 503. */
export function isPiSecretFile(filePath: string): boolean {
  let requestUnavailable = false;
  const markRequestUnavailable = () => { requestUnavailable = true; };
  // Follow the original path before any lexical normalization: link/.. is
  // resolved by the filesystem, not necessarily by path.resolve's string rules.
  const requested = resolvedOrSelf(filePath, markRequestUnavailable);
  const target = comparablePath(requested);
  const name = path.basename(requested);
  const parents = new Set([path.dirname(requested), resolvedOrSelf(path.dirname(filePath), markRequestUnavailable)].map(comparablePath));
  let metadataUnavailable = false;
  const markUnavailable = () => { metadataUnavailable = true; };
  const agentDirs = new Set([getAgentDir(), path.join(getConfigRoot(), "agent")]);
  // Deny-first: either reading of the path inside tau's state tree is enough.
  const candidates = [target, comparablePath(path.resolve(filePath))];
  for (const dir of agentDirs) {
    const tau = path.join(dir, "tau");
    for (const root of new Set([comparablePath(tau), comparablePath(resolvedOrSelf(tau, markUnavailable))])) {
      if (candidates.some((candidate) => candidate === root || candidate.startsWith(`${root}/`))) return true;
    }
  }
  const requestedIdentity = fileIdentity(filePath, markRequestUnavailable);
  const identity = requestedIdentity && requestedIdentity.nlink > 1 && requestedIdentity.ino > 0 ? requestedIdentity : null;
  for (const dir of agentDirs) {
    if (PI_SECRET_NAME.test(name) && (parents.has(comparablePath(dir)) || parents.has(comparablePath(resolvedOrSelf(dir, markUnavailable))))) return true;
    const names = new Set(PI_SECRET_FILES);
    try {
      for (const entry of readdirSync(dir, { encoding: "buffer" })) {
        const name = entry.toString("utf8");
        if (PI_SECRET_NAME.test(name)) {
          if (isUtf8(entry)) names.add(name);
          else metadataUnavailable = true;
        }
      }
    } catch (error) {
      if (!isMissingPathError(error)) metadataUnavailable = true;
    }
    const files = [...[...names].map((name) => path.join(dir, name)), ...TAU_SECRET_FILES.map((name) => path.join(dir, "tau", name)),
      // A member's own credential symlink moved into own-config/ still protects its target.
      ...tauCredentialCopies(dir, markUnavailable)];
    for (const file of files) {
      const canonical = resolvedOrSelf(file, markUnavailable);
      if (target === comparablePath(canonical)) return true;
      if (process.platform === "darwin" && !requestedIdentity && prospectiveMacAlias(requested, canonical, markUnavailable)) return true;
      if (identity) {
        // Stat the configured path first: a canonical string can lose POSIX byte filenames.
        const other = fileIdentity(file, markUnavailable)
          ?? (canonical !== file ? fileIdentity(canonical, markUnavailable) : null);
        if (other && identity.dev === other.dev && identity.ino === other.ino) return true;
      }
    }
    if (identity && clusterObjectIdentities(dir, markUnavailable).has(`${identity.dev}:${identity.ino}`)) return true;
  }
  // Unknown off-tree aliases cannot be declared safe without complete ownership metadata.
  if (requestUnavailable) throw new HostOpError(404, "file_not_found", "Not found");
  if (metadataUnavailable) throw credentialPolicyUnavailable();
  return false;
}

function fileIdentity(filePath: string, onUnavailable?: () => void) {
  try {
    const stat = statSync(withoutWindowsStream(filePath), { bigint: true });
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (!isMissingPathError(error)) onUnavailable?.();
    return null;
  }
}

function withoutWindowsStream(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  const name = path.basename(filePath);
  const stream = name.indexOf(":");
  // Slice the final component only: preserve drive prefixes and native link/.. traversal.
  return stream < 0 ? filePath : filePath.slice(0, filePath.lastIndexOf(name) + stream);
}

function resolvedOrSelf(dir: string, onUnavailable?: () => void, seen?: Set<string>): string {
  const base = withoutWindowsStream(dir);
  try {
    return withoutWindowsStream(realpathSync.native(base));
  } catch (error) {
    if (!isMissingPathError(error)) { onUnavailable?.(); return base; }
  }
  const visited = seen ?? new Set<string>();
  if (visited.has(base)) { onUnavailable?.(); return base; }
  visited.add(base);
  let current = base;
  let suffix = "";
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const bytes = readlinkSync(current, { encoding: "buffer" });
        if (!isUtf8(bytes)) { onUnavailable?.(); return base; }
        const link = bytes.toString("utf8");
        const target = path.isAbsolute(link) ? link : joinWithoutNormalizing(resolvedOrSelf(path.dirname(current), onUnavailable, visited), link);
        return resolvedOrSelf(suffix ? joinWithoutNormalizing(target, suffix) : target, onUnavailable, visited);
      }
      const canonical = withoutWindowsStream(realpathSync.native(current));
      return suffix ? joinWithoutNormalizing(canonical, suffix) : canonical;
    } catch (error) {
      if (!isMissingPathError(error)) { onUnavailable?.(); return base; }
      const parent = path.dirname(current);
      if (parent === current) return base;
      suffix = suffix ? `${path.basename(current)}${path.sep}${suffix}` : path.basename(current);
      current = parent;
    }
  }
}

/** path.join would collapse link/.. before the filesystem can follow the link. */
function joinWithoutNormalizing(parent: string, child: string): string {
  return `${parent}${parent.endsWith(path.sep) ? "" : path.sep}${child}`;
}

/** Missing targets have no inode: calibrate macOS name folding without creating a probe file. */
// shortcut: add mount-specific calibration before supporting prospective aliases on Linux casefold filesystems.
function prospectiveMacAlias(requested: string, owned: string, onUnavailable: () => void): boolean {
  const left = requested.normalize("NFD");
  const right = owned.normalize("NFD");
  if (left === right) return true;
  if (left.toLowerCase().toUpperCase() !== right.toLowerCase().toUpperCase()) return false;
  let directory = path.dirname(owned);
  for (;;) {
    try {
      const original = statSync(directory, { bigint: true });
      const parent = path.dirname(directory);
      if (!original.isDirectory() || parent === directory || statSync(parent, { bigint: true }).dev !== original.dev) break;
      const alternate = path.basename(directory).replace(/[a-zA-Z]/, (letter) => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase());
      if (alternate !== path.basename(directory)) {
        try {
          const alias = statSync(path.join(parent, alternate), { bigint: true });
          return original.dev === alias.dev && original.ino === alias.ino;
        } catch (error) {
          if (!isMissingPathError(error)) break;
          const stillPresent = statSync(directory, { bigint: true });
          if (original.dev === stillPresent.dev && original.ino === stillPresent.ino) return false;
          break;
        }
      }
      directory = parent;
    } catch (error) {
      if (!isMissingPathError(error)) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  onUnavailable();
  return false;
}

/** Canonical comparison keys preserve literal POSIX backslashes and fold Windows path spelling only. */
function comparablePath(filePath: string): string {
  const normalized = (process.platform === "win32" ? normalizeSlashes(filePath) : filePath).replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}


export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;
  // This machine's sessions, as its daemon lists them (the last list while it is offline).
  const sessions = await hostSessions(LOCAL_HOST_ID);
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }
  for (const root of getAdditionalAllowedRoots()) roots.add(root);
  // Config roots are appended LAST: a relative request must fan out over real
  // workspaces (session cwds, project roots, allowFileRoot() roots) before it
  // can land in ~/.pi or ~/.agents.
  for (const root of getConfigAgentRoots()) roots.add(root);
  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    // `\\?\C:\x` and `C:\x` name the same file: compare without the namespace prefix on either side.
    const n = resolver.resolve(useWindowsRules ? stripLongPathPrefix(target) : target);
    const nr = resolver.resolve(useWindowsRules ? stripLongPathPrefix(root) : root);
    const c = useWindowsRules ? n.toLowerCase() : n;
    const cr = useWindowsRules ? nr.toLowerCase() : nr;
    const withSep = cr.endsWith(sep) ? cr : cr + sep;
    if (c === cr || c.startsWith(withSep)) return true;
  }
  return false;
}

export const isFilePathAllowed = isPathWithinRoots;

/** An /api/files request path is absolute when it is a posix `/…` root, a
 *  Windows drive `C:/…` path, or a UNC `//server/share…` path. Everything else
 *  is relative and only becomes meaningful once resolved against a root. */
export function isAbsoluteFileRequestPath(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath);
  return normalized.startsWith("/") || isWindowsAbsolutePath(normalized);
}

/**
 * Resolve a *relative* /api/files request path against the allowed roots.
 *
 * `components/MarkdownBody.tsx` linkifies bare workspace paths (`package.json`,
 * `src/foo.ts`) into `/api/files/<encoded>?type=read`, but the catch-all param
 * carries no leading slash, so the route read those as `/package.json` — a path
 * at the filesystem root, in no allowed root, and a 403 (#135).
 *
 * Candidates are tried in allowed-roots Set order (session cwds, then project
 * roots, then allowFileRoot() roots, then the config roots) and the first one
 * that (a) stays inside the root that produced it and (b) exists on disk wins.
 * A `../..` escape resolves out of its root and fails the same prefix check
 * that guards absolute requests, so traversal is rejected identically.
 *
 * Returns null for an absolute request (nothing to resolve) and for a relative
 * one that matches no in-root candidate. Callers must keep their absolute
 * authorization in place — this only ever widens *which in-root path* a
 * relative name maps to, never past a root.
 */
export function resolveRequestedFilePath(requestPath: string, roots: Set<string>): string | null {
  const request = normalizeSlashes(requestPath);
  // Checked before any trimming: a UNC `//server/share` request is absolute,
  // not a relative path with a doubled slash.
  if (!request || isAbsoluteFileRequestPath(request)) return null;
  const relative = request.replace(/^\/+/, "");
  if (!relative) return null;
  for (const root of roots) {
    // Mirror isPathWithinRoots' resolver choice so a Windows-style root stays
    // Windows-style even when the strings are built on another platform.
    const useWindowsRules = isWindowsAbsolutePath(root) || isWindowsAbsolutePath(relative);
    const resolver = useWindowsRules ? path.win32 : path;
    const candidate = resolver.resolve(root, relative);
    // The candidate is checked against the ONE root that produced it, never
    // against the whole set: `path.resolve(root, "../..")` escapes that root.
    if (!isPathWithinRoots(candidate, new Set([root]))) continue;
    if (!existsSync(candidate)) continue;
    return normalizeSlashes(candidate);
  }
  return null;
}

/** isExistingPathWithinRoots for many targets: realpaths the roots once. */
export function existingPathWithinRootsChecker(roots: Set<string>): (target: string) => boolean {
  const realRoots = new Set<string>();
  for (const root of roots) { try { realRoots.add(stripLongPathPrefix(realpathSync(root))); } catch { /* stale */ } }
  return (target) => {
    let realTarget: string;
    try { realTarget = stripLongPathPrefix(realpathSync(target)); } catch { return false; }
    return isPathWithinRoots(realTarget, realRoots);
  };
}

/** `existingPathWithinRootsChecker`, resolving each target without blocking (a scan of many files). */
export async function existingPathWithinRootsCheckerAsync(roots: Set<string>): Promise<(target: string) => Promise<boolean>> {
  const realRoots = new Set<string>();
  for (const root of roots) { try { realRoots.add(stripLongPathPrefix(await realpath(root))); } catch { /* stale */ } }
  return async (target) => {
    try { return isPathWithinRoots(stripLongPathPrefix(await realpath(target)), realRoots); } catch { return false; }
  };
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  return existingPathWithinRootsChecker(roots)(target);
}

export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
