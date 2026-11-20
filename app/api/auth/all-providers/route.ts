import { hostIdOf, hostProviders, listErrorResponse } from "@/lib/host-auth";

// API-key providers on `?hostId=` (default this machine): those pi can store a key for, and those already configured
// some other way (an environment variable). Providers logged in by account show in the subscription list instead;
// models.json providers are managed in the editor tree.
export async function GET(req: Request) {
  try {
    const providers = await hostProviders(hostIdOf(req));
    const result = providers
      .filter((p) => p.stored !== "oauth" && !p.custom && (p.apiKeyLogin || p.configured))
      .map((p) => ({ id: p.id, displayName: p.name, configured: p.configured, modelCount: p.models, apiKeyLogin: p.apiKeyLogin, stored: p.stored }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return Response.json({ providers: result });
  } catch (error) {
    return listErrorResponse(error);
  }
}
