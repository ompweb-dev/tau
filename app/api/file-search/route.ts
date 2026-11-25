import { apiErrorResponse, opErrorResponse, resolveWorkspaceHost } from "@/lib/api-utils";

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const resolved = await resolveWorkspaceHost(params.get("hostId") ?? undefined, params.get("sessionId"));
    if ("response" in resolved) return resolved.response;
    const result = await resolved.host.workspaceOps.searchText(
      resolved.cwd ?? params.get("cwd")?.trim() ?? "", params.get("q") ?? "", params.get("case") === "1", resolved.owner,
    );
    return result.ok ? Response.json(result.value) : opErrorResponse(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
