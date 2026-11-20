import { realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getConfigAgentRoots, isFilePathAllowed, normalizeSlashes } from "../file-access";
import { authorizeFileAccess } from "../file-authorization";
import { filePathApiSegments } from "../file-paths";
import { loadProjectRegistry } from "../project-registry";
import { listAllSessions, readSessionHeader, resolveSessionPath } from "../session-reader";
import { HostOpError } from "./link-protocol";
import type { WorkspaceOwner } from "../workspace-types";
import { resolveProject } from "../worktree";
import { isValidSessionId } from "../session-file-references-core";
import { getAgentDir, getConfigRoot } from "../pi/paths";

const grants = new Set<string>();
let cached: { roots: Set<string>; until: number } | null = null;

export function invalidateWorkspaceRoots(): void { cached = null; }

export function grantWorkspaceRoot(path: string): void {
  grants.add(normalizeSlashes(realpathSync(path)));
  grants.add(normalizeSlashes(resolve(path)));
  invalidateWorkspaceRoots();
}

export async function getWorkspaceRoots(owner?: WorkspaceOwner): Promise<Set<string>> {
  if (owner !== undefined) {
    if (!owner || !isValidSessionId(owner.sessionId) || typeof owner.cwd !== "string" || owner.cwd.includes("\0") || !isAbsolute(owner.cwd)) {
      throw new HostOpError(400, "invalid_request", "Invalid workspace owner");
    }
    const file = await resolveSessionPath(owner.sessionId);
    const cwd = (file ? readSessionHeader(file)?.cwd : undefined) || owner.cwd;
    if (!isAbsolute(cwd) || cwd.includes("\0")) throw new HostOpError(400, "invalid_request", "Invalid native session workspace");
    const roots = new Set([normalizeSlashes(cwd), normalizeSlashes((await resolveProject(cwd)).projectRoot)]);
    for (const root of getConfigAgentRoots()) roots.add(root);
    return roots;
  }
  if (cached && cached.until > Date.now()) return cached.roots;
  const roots = new Set<string>();
  for (const session of await listAllSessions()) {
    if (session.cwd) roots.add(normalizeSlashes(session.cwd));
    if (session.projectRoot) roots.add(normalizeSlashes(session.projectRoot));
  }
  for (const project of loadProjectRegistry().projects) {
    if (!project.hidden) roots.add(normalizeSlashes(project.path));
  }
  for (const grant of grants) roots.add(grant);
  try {
    for (const entry of readdirSync(homedir(), { withFileTypes: true })) {
      if (entry.isDirectory() && /^tau-cwd-\d{8}$/.test(entry.name)) roots.add(normalizeSlashes(join(homedir(), entry.name)));
    }
  } catch { /* A missing home does not authorize any scratch directory. */ }
  for (const root of getConfigAgentRoots()) roots.add(root);
  cached = { roots, until: Date.now() + 5_000 };
  return roots;
}

/** Writes require an explicit absolute directory, never read-path root fanout. */
export async function authorizeWorkspaceDirectory(directory: string, owner?: WorkspaceOwner): Promise<string> {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new HostOpError(400, "invalid_request", "An absolute directory is required");
  const roots = await getWorkspaceRoots(owner);
  if (!isFilePathAllowed(directory, roots)) throw new HostOpError(403, "access_denied", "Access denied");
  const checked = await authorizeFileAccess(filePathApiSegments(directory), null, false, roots);
  if (!checked.ok) throw new HostOpError(checked.status, checked.code, checked.error);
  if (!checked.stat.isDirectory()) throw new HostOpError(400, "not_a_directory", "The destination is not a directory");
  return realpathSync(checked.filePath);
}

const identityOf = (path: string) => { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; };

const READ_ONLY = () => new HostOpError(403, "agent_dir_read_only", "pi's agent directory is read-only here");

/** `path` with its nearest existing ancestor canonicalized (symlinks, `..`) and the missing rest appended. Only a missing
 *  component is walked past: any other failure (a loop, no access) cannot be checked, so it refuses. */
function canonicalPath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(existing), ...rest.reverse()); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ENOTDIR") || dirname(existing) === existing) {
        throw new HostOpError(403, "access_denied", "The destination cannot be checked");
      }
      rest.push(basename(existing));
      existing = dirname(existing);
    }
  }
}

// macOS and Windows filesystems ignore case by default: a missing `~/.PI` would be pi's `~/.pi`.
const fold = (path: string) => process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
const within = (path: string, root: string) => {
  const [p, r] = [fold(path), fold(root)];
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
};

/**
 * The Files panel and other user-requested workspace writes never touch pi's agent directory or `~/.pi`: refuse when
 * any target is that directory or lies below it, also while it does not exist yet (a clone must not create `~/.pi`);
 * `assertRemovableOutsideAgentDir` also refuses a target that holds it (removing a worktree that contains it). Paths are canonicalized (symlinks, `..`), and each existing ancestor
 * is also compared by device and inode, so case or bind-mount aliases of the agent directory match too.
 * Internal writes (composer attachments into a session's `local/uploads/`) do not come through here.
 */
export function assertOutsideAgentDir(...targets: string[]): void {
  checkAgentDir(targets, false);
}

export function assertRemovableOutsideAgentDir(target: string): void {
  checkAgentDir([target], true);
}

function checkAgentDir(targets: string[], removing: boolean): void {
  const protectedPaths = [getAgentDir(), getConfigRoot()].map(canonicalPath);
  const protectedIds = new Set<string>();
  for (const dir of protectedPaths) {
    try { protectedIds.add(identityOf(dir)); } catch { /* Missing: compared by path only. */ }
  }
  for (const target of targets) {
    const path = canonicalPath(target);
    if (protectedPaths.some((dir) => within(path, dir) || (removing && within(dir, path)))) throw READ_ONLY();
    for (let dir = path; ; dir = dirname(dir)) {
      let id: string | null = null;
      try { id = identityOf(dir); } catch { /* A missing component: its existing ancestors are checked next. */ }
      if (id && protectedIds.has(id)) throw READ_ONLY();
      if (dirname(dir) === dir) break;
    }
  }
}

/** `authorizeWorkspaceDirectory` for a directory the request will write into. */
export async function authorizeWritableDirectory(directory: string, owner?: WorkspaceOwner): Promise<string> {
  const canonical = await authorizeWorkspaceDirectory(directory, owner);
  assertOutsideAgentDir(canonical);
  return canonical;
}
