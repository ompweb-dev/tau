import { apiErrorResponse } from "@/lib/api-utils";
import { afterAuthChange, hostIdOf, hostProviders, providerIdOr400 } from "@/lib/host-auth";
import { authOp } from "@/lib/hosts/hub";
import { isRecord } from "@/lib/type-guards";

type Params = { params: Promise<{ provider: string }> };

// GET /api/auth/api-key/[provider]?hostId= — auth status on that host (never the key)
export async function GET(req: Request, { params }: Params) {
  const { provider } = await params;
  const invalid = providerIdOr400(provider);
  if (invalid) return invalid;
  try {
    const entry = (await hostProviders(hostIdOf(req))).find((p) => p.id === provider);
    return Response.json({ provider, displayName: entry?.name ?? provider, configured: entry?.configured === true, models: entry?.models ?? 0, stored: entry?.stored ?? null });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// POST /api/auth/api-key/[provider]?hostId= { key } — store the key in that host's pi auth.json
export async function POST(req: Request, { params }: Params) {
  const { provider } = await params;
  const invalid = providerIdOr400(provider);
  if (invalid) return invalid;
  const body: unknown = await req.json().catch(() => null);
  const key = isRecord(body) && typeof body.key === "string" ? body.key.trim() : "";
  if (!key) return Response.json({ error: "key is required", code: "invalid_request" }, { status: 400 });
  const hostId = hostIdOf(req);
  try {
    await authOp(hostId, { action: "setApiKey", provider, key }, 60_000);
    afterAuthChange(hostId);
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

// DELETE /api/auth/api-key/[provider]?hostId= — remove the stored credential (environment variables and models.json stay)
export async function DELETE(req: Request, { params }: Params) {
  const { provider } = await params;
  const invalid = providerIdOr400(provider);
  if (invalid) return invalid;
  const hostId = hostIdOf(req);
  try {
    await authOp(hostId, { action: "logout", provider }, 60_000);
    afterAuthChange(hostId);
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
