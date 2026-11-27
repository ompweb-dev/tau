import { getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { commandErrorResponse, runAgentCommand } from "@/lib/agent-command";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { requestOwner } from "@/lib/web-auth";
import { hostIdParam } from "@/lib/api-utils";

/** Stamp when the handler had the request and when it answered, so the browser
 * can split network time from server time. */
function timed(receivedAt: number, res: Response): Response {
  res.headers.set("x-tau-received-at", String(receivedAt));
  res.headers.set("x-tau-replied-at", String(Date.now()));
  return res;
}

// POST /api/agent/[id]?hostId= - Send a command to an existing session (that host's copy when named)
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Once the body is in, as a socket's ack is stamped after its whole frame: proxies stream uploads through, so the
  // handler starts before a large body has arrived. A body that fails to read is stamped when it failed.
  let receivedAt: number | undefined;

  try {
    const body = await parseJsonWithinLimit<unknown>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    receivedAt = Date.now();
    const host = hostIdParam(new URL(req.url).searchParams.get("hostId"));
    if ("response" in host) return timed(receivedAt, host.response);
    return timed(receivedAt, await runAgentCommand(id, body, requestOwner(req), { hostId: host.hostId }));
  } catch (error) {
    return timed(receivedAt ?? Date.now(), commandErrorResponse(error));
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Default stays the full shape; `?systemPrompt=0` drops the ~13 KB prompt
  // from the 15 s state poll. Any other value (including "1") keeps it.
  const { searchParams } = new URL(req.url);
  const includeSystemPrompt = searchParams.get("systemPrompt") !== "0";

  const host = hostIdParam(searchParams.get("hostId"));
  if ("response" in host) return host.response;
  try {
    // `?hostId=`: only that host's copy; the same id live on another host is another session.
    const session = getRpcSession(id, host.hostId);
    if (!session || !session.isAlive()) {
      return Response.json({ running: false });
    }
    try {
      // Through the wrapper's command path, not a dedicated method: that is
      // the contract every wrapper fake implements, and `dispatchCommand`
      // already honors `systemPrompt: false`.
      const state = await session.send({
        type: "get_state",
        ...(includeSystemPrompt ? {} : { systemPrompt: false }),
      });
      return Response.json({ running: true, state });
    } catch (error) {
      if (error instanceof WebRpcError && error.code === "session_unresponsive") {
        return Response.json({ running: false, recovered: true });
      }
      throw error;
    }
  } catch (error) {
    return commandErrorResponse(error);
  }
}
