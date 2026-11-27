import { createHash } from "crypto";
import { pooledWorkspaceForSession } from "./hosts/pool-starts";
import { isValidSessionId } from "./session-file-references-core";
import { isLinkUp, type Host } from "./hosts/host";
import { getHost } from "./hosts/hub";
import { HostOpError } from "./hosts/link-protocol";
import type { OpResult } from "./hosts/session-ops";
import { hostForSessionId, hostHoldingSession, hostSessions } from "./hosts/session-index";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { getRpcSession, WebRpcError } from "./rpc-manager";
import type { WorkspaceOwner } from "./workspace-types";

const SESSION_NOT_FOUND = { error: "Session not found", code: "session_not_found" } as const;

/** Resolve a session id to the host holding its file: a live session's own host first, then the
 * hosts' lists (only the named host's with `hostId`). A 404 JSON response only when absence is
 * confirmed (across all hosts, or on the named one); otherwise 503. */
export async function resolveSessionHostOr404(
  id: string,
  /** The host the caller's row names (`?hostId=`): the same id on another host is not this session. */
  hostId?: string | null,
): Promise<{ host: Host } | { response: Response }> {
  const live = getRpcSession(id, hostId);
  if (live?.isAlive()) return { host: live.host };
  try {
    const host = hostId ? await hostHoldingSession(id, hostId) : await hostForSessionId(id);
    return host ? { host } : { response: Response.json(SESSION_NOT_FOUND, { status: 404 }) };
  } catch (error) {
    // Nothing was sent: a command the composer holds is refused, not lost.
    if (error instanceof HostOpError && error.code === "host_offline") return { response: apiErrorResponse(new WebRpcError(error.message, "host_offline", "refused")) };
    if (error instanceof HostOpError && error.code === "host_sessions_unavailable") return { response: apiErrorResponse(error) };
    throw error;
  }
}

/** 503 `{hostOffline: true, delivery: "refused"}` while a host's link is down; null when it takes requests. */
export function hostOfflineResponse(host: Host): Response | null {
  if (isLinkUp(host.status())) return null;
  return apiErrorResponse(new WebRpcError(`${host.label} is offline`, "host_offline", "refused"));
}

/** The host a request names (`hostId`, this machine when absent): 404 when unknown, 503 while offline. */
export function resolveHostOrError(hostId: unknown): { host: Host } | { response: Response } {
  const host = hostId === undefined ? getHost(LOCAL_HOST_ID) : typeof hostId === "string" ? getHost(hostId) : null;
  if (!host) return { response: Response.json({ error: "Host not found", code: "host_not_found" }, { status: 404 }) };
  const offline = hostOfflineResponse(host);
  return offline ? { response: offline } : { host };
}

/** The host a workspace request runs on, plus the session identity to send it. File reads and watches keep the id the
 * request gave: a tab owns the session it was opened for, and a later move must not swap in another session's root.
 * Its live file is passed only while the wrapper still reports that id. */
export async function resolveWorkspaceHost(
  hostId: unknown,
  sessionId: string | null,
): Promise<{ host: Host; sessionId: string | null; sessionFile: string | null; cwd: string | null; owner?: WorkspaceOwner } | { response: Response }> {
  if (sessionId === null) {
    const resolved = resolveHostOrError(hostId);
    return "response" in resolved ? resolved : { host: resolved.host, sessionId: null, sessionFile: null, cwd: null };
  }
  if (!isValidSessionId(sessionId)) return { response: Response.json(SESSION_NOT_FOUND, { status: 404 }) };
  // The named host's copy of an id first; any other copy answers 409 below.
  const named = typeof hostId === "string" ? hostId : null;
  const live = getRpcSession(sessionId, named);
  const running = live?.isAlive() ? live : undefined;
  const retained = running?.sessionId === sessionId ? null : pooledWorkspaceForSession(sessionId);
  let holder: Host | null = null;
  if (!running && named && retained?.hostId !== named) {
    try {
      holder = await hostHoldingSession(sessionId, named);
    } catch (error) {
      // The named host cannot say: retryable, never another host's copy.
      if (error instanceof HostOpError && error.code === "host_offline") return { response: apiErrorResponse(new WebRpcError(error.message, "host_offline", "refused")) };
      if (error instanceof HostOpError && error.code === "host_sessions_unavailable") return { response: apiErrorResponse(error) };
      throw error;
    }
  }
  let session: { host: Host } | { response: Response };
  if (running) session = { host: running.host };
  else if (holder) session = { host: holder };
  else if (retained) {
    const host = getHost(retained.hostId);
    if (!host) return { response: Response.json(SESSION_NOT_FOUND, { status: 404 }) };
    session = { host };
  } else session = await resolveSessionHostOr404(sessionId);
  if ("response" in session) return session;
  const offline = hostOfflineResponse(session.host);
  if (offline) return { response: offline };
  if (hostId !== undefined && hostId !== session.host.id) {
    return { response: Response.json({ error: "The session belongs to another host", code: "workspace_host_mismatch" }, { status: 409 }) };
  }
  const cwd = (running?.sessionId === sessionId ? running.cwd : undefined) ?? (retained?.hostId === session.host.id ? retained.cwd : undefined)
    ?? (await hostSessions(session.host.id)).find((entry) => entry.id === sessionId)?.cwd;
  if (!cwd) return { response: Response.json(SESSION_NOT_FOUND, { status: 404 }) };
  return { host: session.host, sessionId,
    sessionFile: running?.sessionId === sessionId ? running.sessionFile || null : null,
    cwd, owner: { sessionId, cwd } };
}

/** The JSON error response for a failed host op. */
export function opErrorResponse(result: Extract<OpResult<unknown>, { ok: false }>): Response {
  return Response.json({ error: result.error, code: result.code }, { status: result.status });
}

/** Strong, quoted ETag from the inputs that identify one response body. */
export function strongEtag(identity: string): string {
  return `"${createHash("sha256").update(identity).digest("hex").slice(0, 32)}"`;
}

/** Whether an `If-None-Match` header covers `etag` (`*` always does). Uses the
 *  weak comparison RFC 9110 §13.1.2 requires, so a proxy that weakens our
 *  strong tag (`W/"…"`) still gets its 304. */
export function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (!header) return false;
  const expected = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//, "") === expected;
  });
}

/** Uniform JSON error body used by most API routes. A host link failure keeps
 * its status (503 offline, 504 timeout) and code; a session whose host is
 * offline answers 503 `{hostOffline: true}`, plus its `delivery` for an agent
 * command ("unknown": the link dropped after it was sent, so it may still run). */
export function apiErrorResponse(error: unknown, status = 500): Response {
  if (error instanceof HostOpError || (error instanceof WebRpcError && error.code === "host_offline")) {
    const offline = error.code === "host_offline";
    const delivery = error instanceof WebRpcError ? error.delivery : undefined;
    return Response.json(
      { error: error.message, code: error.code, ...(offline ? { hostOffline: true } : {}), ...(delivery ? { delivery } : {}) },
      { status: error instanceof HostOpError ? error.status : 503 },
    );
  }
  return Response.json({ error: String(error) }, { status });
}

