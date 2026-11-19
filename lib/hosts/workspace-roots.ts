import { realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

/**
 * The Files panel and other user-requested workspace writes never touch pi's agent directory or `~/.pi`: refuse when
 * any target is that directory or below it. Each target's nearest existing ancestor is canonicalized (symlinks, `..`)
 * and its ancestors compared by device and inode, so case or bind-mount aliases of the agent directory match too.
 * Internal writes (composer attachments into a session's `local/uploads/`) do not come through here.
 */
export function assertOutsideAgentDir(...targets: string[]): void {
  const protectedIds = new Set<string>();
  for (const dir of [getAgentDir(), getConfigRoot()]) {
    try { protectedIds.add(identityOf(realpathSync(dir))); } catch { /* A missing directory holds nothing to protect. */ }
  }
  if (!protectedIds.size) return;
  for (const target of targets) {
    let existing = resolve(target);
    for (;;) {
      try { existing = realpathSync(existing); break; }
      catch {
        const parent = dirname(existing);
        if (parent === existing) throw new HostOpError(403, "agent_dir_read_only", "pi's agent directory is read-only here");
        existing = parent;
      }
    }
    for (let dir = existing; ; dir = dirname(dir)) {
      if (protectedIds.has(identityOf(dir))) throw new HostOpError(403, "agent_dir_read_only", "pi's agent directory is read-only here");
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
