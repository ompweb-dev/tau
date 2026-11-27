import { getExitedRpcSession, getLiveRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { apiErrorResponse, hostIdParam, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { outboxScope, outboxSnapshot } from "@/lib/message-outbox";

/** Every answer, an offline host's 503 included, carries the session's held messages (`outbox`): a tab opening a
 * session with no pi running learns from it that there is an outbox to subscribe to. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const host = hostIdParam(new URL(req.url).searchParams.get("hostId"));
  if ("response" in host) return host.response;
  const { hostId } = host;
  const response = await sessionState(id, hostId);
  const { entries, settledIds, ...settlements } = outboxSnapshot(id, hostId);
  return Response.json({
    ...(await response.json() as object),
    outbox: entries,
    outboxScope: outboxScope(),
    outboxSettledIds: settledIds,
    ...settlements,
  }, { status: response.status });
}

async function sessionState(id: string, hostId: string | null): Promise<Response> {
  try {
    // A live process proves the session exists: pi does not create the session
    // file until the history holds a user or assistant message, so the path check
    // below would 404 a brand-new running session.
    const rpc = getLiveRpcSession(id, hostId);
    if (rpc?.isAlive()) {
      try {
        const state = await rpc.send({ type: "get_state" });
        return Response.json({ running: true, state });
      } catch (error) {
        if (error instanceof WebRpcError && error.code === "session_unresponsive") {
          return Response.json({ running: false, recovered: true });
        }
        throw error;
      }
    }

    // An exit mark is its host's: the same id on another host is another session.
    const exited = getExitedRpcSession(id, hostId);
    if (exited) return Response.json({ running: false, exited });

    const resolved = await resolveSessionHostOr404(id, hostId);
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.sessionOps.readSessionState(id);
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
