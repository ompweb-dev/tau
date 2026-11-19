import { apiErrorResponse } from "@/lib/api-utils";
import { afterAuthChange, hostIdOf, hostProviders, providerIdOr400 } from "@/lib/host-auth";
import { authOp } from "@/lib/hosts/hub";

type Params = { params: Promise<{ provider: string }> };

/** The credential pi stores for one provider on `?hostId=`: at most one (auth.json keeps one per provider), id 0. */
export async function GET(req: Request, { params }: Params) {
  const { provider } = await params;
  const invalid = providerIdOr400(provider);
  if (invalid) return invalid;
  try {
    const entry = (await hostProviders(hostIdOf(req))).find((p) => p.id === provider);
    const accounts = entry?.stored ? [{ credentialId: 0, label: entry.name, detail: entry.stored === "oauth" ? "OAuth" : "API key", type: entry.stored }] : [];
    return Response.json({ supported: true, accounts });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Remove the stored credential (`?credentialId=0`). */
export async function DELETE(req: Request, { params }: Params) {
  if (new URL(req.url).searchParams.get("credentialId") !== "0") {
    return Response.json({ error: "credentialId must be 0", code: "invalid_request" }, { status: 400 });
  }
  const { provider } = await params;
  const invalid = providerIdOr400(provider);
  if (invalid) return invalid;
  const hostId = hostIdOf(req);
  try {
    await authOp(hostId, { action: "logout", provider }, 60_000);
    afterAuthChange(hostId, provider, false);
    return Response.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
