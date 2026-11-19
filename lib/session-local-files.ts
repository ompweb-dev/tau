// A session's own `local/` directory (where composer uploads land) on the machine that runs this code: which directory
// it is, and whether a path lies in it. Resolves on the owning Node daemon, without consulting main's live-session or
// host state. The session id and the daemon's index (or a verified live-file hint) name the file; `sessionLocalRoot`
// (shared with composer uploads) names its directory, never the cwd or viewed session.
import path from "node:path";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./file-access";
import { getSessionsDir, sessionLocalRoot } from "./pi/paths";
import { readSessionHeaderSync } from "./pi/session-files";
import { isValidSessionId } from "./session-file-references-core";
import { resolveSessionPath } from "./session-reader";

type SessionLocalFailure = { ok: false; status: 404; code: string; error: string };
type SessionLocalRoot = { ok: true; root: string } | SessionLocalFailure;

const SESSION_NOT_FOUND: SessionLocalFailure = { ok: false, status: 404, code: "session_not_found", error: "Session not found" };

/** A live-file hint wins only when it is inside this daemon's sessions directory and its header names the session.
 * Otherwise the caller falls back to the daemon's own index, including any custom session files it knows. */
function verifiedSessionFile(sessionId: string, hint: string | null | undefined): string | null {
  if (typeof hint !== "string" || !path.isAbsolute(hint) || !hint.endsWith(".jsonl")
    || !isExistingPathWithinRoots(hint, new Set([getSessionsDir()]))) return null;
  return readSessionHeaderSync(hint)?.id === sessionId ? hint : null;
}

/** The local root of a session on this machine: a verified live-file hint wins over the daemon's session index,
 * which lags a new session. 404 when neither names a file. */
async function sessionLocalRootFor(sessionId: string | null, hint: string | null | undefined): Promise<SessionLocalRoot> {
  if (!isValidSessionId(sessionId)) return SESSION_NOT_FOUND;
  const sessionFile = verifiedSessionFile(sessionId, hint) ?? (await resolveSessionPath(sessionId));
  return sessionFile ? { ok: true, root: sessionLocalRoot(sessionFile, sessionId) } : SESSION_NOT_FOUND;
}

/** The session's local root when `filePath` lies inside it: what lets a tab read its own session's artifacts wherever
 * the host keeps them. `sessionFile` is main's optional hint of the live file (verified, never trusted). Null for
 * anything else, and for any failure to find the session. */
export async function sessionLocalRootContaining(filePath: string, sessionId: string | null, sessionFile?: string | null): Promise<string | null> {
  try {
    const located = await sessionLocalRootFor(sessionId, sessionFile);
    return located.ok && isPathWithinRoots(filePath, new Set([located.root])) ? located.root : null;
  } catch {
    return null;
  }
}
