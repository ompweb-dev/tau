import { apiErrorResponse, hostOfflineResponse, opErrorResponse, resolveSessionHostOr404, sessionGoneEverywhere } from "@/lib/api-utils";
import { HostOpError } from "@/lib/hosts/link-protocol";
import { invalidateHostSessionList } from "@/lib/hosts/session-index";
import { clearExitedRpcSession, getRpcSession } from "@/lib/rpc-manager";

/** POST /api/sessions/[id]/archive?hostId= — stop the live child, then archive the
 * native pi JSONL and its sibling artifacts (lib/pi/archive.ts), on the row's host. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id, new URL(req.url).searchParams.get("hostId"));
    if ("response" in resolved) return resolved.response;
    const { sessionOps } = resolved.host;
    // Parent-session paths are native branch metadata. Moving only a parent
    // would leave active children pointing at a path that no longer exists,
    // flattening their tree in the sidebar. Archive leaves first instead.
    const hasChildren = (await sessionOps.listSessions()).some((session) => session.parentSessionId === id);
    if (hasChildren) {
      return Response.json(
        { error: "Archive child sessions before archiving this session", code: "session_has_children" },
        { status: 409 },
      );
    }

    // pi owns writes while a child is live; wait for its exit before
    // moving the file so the archive contains the complete native transcript.
    // Disposing a child behind a down link would wait for the link to return.
    const offline = hostOfflineResponse(resolved.host);
    if (offline) return offline;
    // Only this host's child: the same id live on another host is another session.
    const live = getRpcSession(id);
    if (live?.host.id === resolved.host.id && !live.hostOwnedLifecycle) await live.destroyAndWait?.("archive", true);
    const result = await sessionOps.archiveSession(id);
    if (!result.ok) return opErrorResponse(result);
    invalidateHostSessionList(resolved.host.id);
    if (await sessionGoneEverywhere(id)) clearExitedRpcSession(id);
    return Response.json({ ok: true, archived: true, archivedPath: result.value.archivedPath });
  } catch (error) {
    if (error instanceof HostOpError) return apiErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: "session_archive_failed" }, { status: 500 });
  }
}
