import { hostIdOf, hostProviders, listErrorResponse } from "@/lib/host-auth";

// Providers with an account (OAuth) login on `?hostId=` (default this machine), as that host's pi lists them.
export async function GET(req: Request) {
  try {
    const providers = await hostProviders(hostIdOf(req));
    return Response.json({
      providers: providers.filter((p) => p.oauth).map((p) => ({ id: p.id, name: p.name, usesCallbackServer: false, loggedIn: p.stored === "oauth" })),
    });
  } catch (error) {
    return listErrorResponse(error);
  }
}
