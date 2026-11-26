import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const resolved = await resolveWorkspaceHost(params.get("hostId") ?? undefined, params.get("sessionId"));
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.searchText(
      // The panel's folder (a worktree, the sidebar's workspace), authorized against the session's roots.
      params.get("cwd")?.trim() || resolved.cwd || "", params.get("q") ?? "", params.get("case") === "1",
      (params.get("client") ?? "").slice(0, 64), resolved.owner,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
