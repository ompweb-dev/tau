import { deriveSessionTitleFromFirstMessage, sanitizeSessionTitle } from "@/lib/session-title";
import { getRpcSession } from "@/lib/rpc-manager";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { apiErrorResponse, opErrorResponse, resolveSessionHostOr404 } from "@/lib/api-utils";

/**
 * POST /api/sessions/[id]/auto-name
 *
 * pi has no title generator: answers the existing title, else a title derived
 * from the first user message, which it saves (through the live process when
 * there is one, else as a session_info entry in the file). `generated` is always false.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const { sessionOps } = resolved.host;

    const info = (await sessionOps.listSessions()).find((session) => session.id === id);
    const storedTitle = sanitizeSessionTitle(info?.name);
    if (storedTitle) {
      return Response.json({ title: storedTitle, generated: false, usage: null });
    }

    const derived = deriveSessionTitleFromFirstMessage(info?.firstMessage);
    if (!derived) {
      return Response.json(
        { error: "The session has no user messages to name", code: "session_no_messages_to_name" },
        { status: 409 },
      );
    }

    // The session list read yielded; Edit may now own this session.
    if (getRpcSession(id)?.isEditingHistory()) {
      return Response.json({ error: "Wait for the history edit to finish", code: "session_busy" }, { status: 409 });
    }

    // A live pi holds the session: name it there. Otherwise append to the file.
    const rpc = getRpcSession(id);
    let named = false;
    if (rpc?.isAlive?.()) {
      try {
        await rpc.send({ type: "set_session_name", name: derived });
        named = true;
      } catch {
        // Fall back to the file.
      }
    }
    if (!named) {
      const renamed = await sessionOps.renameSessionFile(id, derived);
      if (!renamed.ok) return opErrorResponse(renamed);
    }
    invalidateHostSessionList(resolved.host.id);
    return Response.json({ title: derived, generated: false, usage: null });
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
