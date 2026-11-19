// Server side of the auth routes (app/api/auth/**): every host, this machine included, keeps its own pi logins, read and
// written by that host's daemon (the `auth` op, lib/hosts/daemon-auth.ts). Never a pi process on main.
import type { HostAuthProvider } from "@/lib/hosts/daemon-auth";
import { authOp } from "@/lib/hosts/hub";
import { HostOpError, PROVIDER_ID_RE } from "@/lib/hosts/link-protocol";
import { LOCAL_HOST_ID } from "@/lib/hosts/registry";
import { invalidateModelsCache } from "@/lib/models-cache";
import { enableProvider } from "@/lib/omp/model-roles";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { isRecord } from "@/lib/type-guards";

export type { HostAuthProvider };

/** `?hostId=`, this machine when absent. */
export function hostIdOf(req: Request): string {
  return new URL(req.url).searchParams.get("hostId") || LOCAL_HOST_ID;
}

/** A provider id from a route parameter, or a 400 answer. */
export function providerIdOr400(provider: string): Response | null {
  return PROVIDER_ID_RE.test(provider) ? null : Response.json({ error: "Invalid provider id", code: "invalid_request" }, { status: 400 });
}

const isProvider = (value: unknown): value is HostAuthProvider => isRecord(value)
  && typeof value.id === "string" && PROVIDER_ID_RE.test(value.id) && typeof value.name === "string"
  && typeof value.oauth === "boolean" && typeof value.apiKeyLogin === "boolean" && typeof value.configured === "boolean"
  && typeof value.custom === "boolean" && typeof value.models === "number"
  && (value.stored === null || value.stored === "api_key" || value.stored === "oauth");

/** The host's providers as its pi reports them; daemon answers are shape-checked. */
export async function hostProviders(hostId: string): Promise<HostAuthProvider[]> {
  const result = await authOp(hostId, { action: "providers" });
  if (!isRecord(result) || !Array.isArray(result.providers)) throw new HostOpError(502, "host_bad_result", "The host sent an invalid provider list");
  return result.providers.filter(isProvider);
}

/** After a login, key or logout on this machine: main's models list and its utility pi read auth.json again. */
export function afterAuthChange(hostId: string, provider: string, loggedIn: boolean): void {
  if (hostId !== LOCAL_HOST_ID) return;
  if (loggedIn) enableProvider(provider);
  invalidateModelsCache();
  disposeUtilityRpc();
}

/** An error answer that still carries `providers: []` for the list routes. */
export function listErrorResponse(error: unknown): Response {
  if (error instanceof HostOpError) return Response.json({ providers: [], error: error.message, code: error.code }, { status: error.status });
  return Response.json({ providers: [], error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}
