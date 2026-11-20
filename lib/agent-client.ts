// Client-side helper for agent commands: POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { recordTransportSample } from "@/lib/event-stream";
import { formatApiError } from "@/lib/i18n/api-error";

const OUTBOX_SCOPE_KEY = "tau:outbox-scope";
let outboxScope: string | null = null;

/** Nonsecret installation/auth fingerprint, not a cookie: reuse it offline, but never rebind a stored entry. */
export function rememberOutboxScope(scope: string): void {
  outboxScope = scope;
  try { localStorage.setItem(OUTBOX_SCOPE_KEY, scope); } catch { /* Storage blocked: this page still knows it. */ }
}

export async function getOutboxScope(sessionId: string): Promise<string> {
  if (!outboxScope) {
    try { outboxScope = localStorage.getItem(OUTBOX_SCOPE_KEY); } catch { /* Ask the server instead. */ }
  }
  if (!outboxScope) {
    const result = await sendAgentCommand<{ scope: string }>(sessionId, { type: "outbox_scope" });
    if (!result?.scope) throw new Error("The message cannot be saved until tau has confirmed this installation.");
    rememberOutboxScope(result.scope);
    return result.scope;
  }
  return outboxScope;
}

// The `hang` sample's patience for a POST: 10 s plus 1 ms per 32 bytes to upload first (a 32 KB/s floor).
const HANG_AFTER_MS = 10_000;

/**
 * This tab's unanswered POSTs, for a later one's isolation bytes (spec D6 "Uplink"). fetch reports no upload progress
 * and the server's receive time arrives only with the response, so a POST counts until answered, even once its body is
 * in; the summary's LARGE_FRAME_BYTES floor keeps a small command the server is still running from reading as blocking.
 */
const inFlightPosts = new Set<{ sessionId: string; bytes: number }>();

/** 503 `{hostOffline: true}`: the session's host has no link right now. With
 *  `delivery: "refused"` the request never left, so the caller keeps what the
 *  user typed; with `"unknown"` the link dropped after it was sent, so it may
 *  still run once the host reconnects (`mayHaveRun`). */
export class HostOfflineError extends Error {
  readonly mayHaveRun: boolean;

  constructor(message: string, mayHaveRun = false) {
    super(message);
    this.mayHaveRun = mayHaveRun;
  }
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  // The sample's request id; no crypto.randomUUID (insecure LAN origins lack it).
  const req = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const json = JSON.stringify(command);
  // Every command's `action` sample (spec D6); the worker adds the tags and its clock.
  const type = typeof command.type === "string" ? command.type : "";
  const sample = { metric: "action", req, type, session: sessionId, bytes: json.length, sentAt: Date.now() };
  let reply: Awaited<ReturnType<typeof postAgentCommand>>;
  try {
    reply = await postAgentCommand(sessionId, json, req, type);
  } catch (error) {
    // The POST got no answer at all (offline, connection reset).
    recordTransportSample({ ...sample, via: "http", socket: "http", status: 0, outcome: "error", gotAt: Date.now() });
    throw error;
  }
  const body = reply.body as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    hostOffline?: boolean;
    delivery?: string;
  };
  const failed = reply.status < 200 || reply.status >= 300 || Boolean(body.error);
  const outcome = failed ? "error" : "ok";
  recordTransportSample({
    ...sample,
    via: reply.via,
    socket: reply.socket,
    status: reply.status,
    outcome,
    behindBytes: reply.behindBytes,
    behindSameBytes: reply.behindSameBytes,
    behindOtherBytes: reply.behindOtherBytes,
    replyBehindOtherBytes: reply.replyBehindOtherBytes,
    recvAt: reply.recvAt,
    repliedAt: reply.repliedAt,
    gotAt: Date.now(),
  });
  if (failed) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    const message = body.error || body.code ? formatApiError(body) : `HTTP ${reply.status}`;
    if (reply.status === 503 && body.hostOffline) throw new HostOfflineError(message, body.delivery === "unknown");
    throw Object.assign(new Error(message), { code: body.code });
  }
  return body.data as T;
}

async function postAgentCommand(sessionId: string, body: string, req: string, type: string) {
  let behindSameBytes = 0;
  let behindOtherBytes = 0;
  for (const other of inFlightPosts) {
    if (other.sessionId === sessionId) behindSameBytes += other.bytes;
    else behindOtherBytes += other.bytes;
  }
  const mine = { sessionId, bytes: body.length };
  inFlightPosts.add(mine);
  // The hang formula over all this tab has in flight (HTTP/2 shares one connection); it records, never aborts.
  const waitedMs = HANG_AFTER_MS + Math.ceil((behindSameBytes + behindOtherBytes + body.length) / 32);
  const hang = setTimeout(() => recordTransportSample({ metric: "hang", socket: "http", req, type, via: "http", bytes: body.length, waitedMs }), waitedMs);
  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // The route's receive/reply times; test fetch fakes carry no headers.
    const time = (name: string) => {
      const value = res.headers?.get?.(name);
      return value ? Number(value) : null;
    };
    return {
      status: res.status,
      body: await res.json().catch(() => ({})),
      via: "http" as const,
      recvAt: time("x-tau-received-at"),
      repliedAt: time("x-tau-replied-at"),
      socket: "http",
      behindBytes: behindSameBytes,
      behindSameBytes,
      behindOtherBytes,
      replyBehindOtherBytes: null,
    };
  } finally {
    clearTimeout(hang);
    inFlightPosts.delete(mine);
  }
}
