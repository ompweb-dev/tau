import { isClusterMember, leaveCluster } from "@/lib/hosts/cluster";
import { closeHostLink, hostsSnapshot, listHosts, notifyHostsChange } from "@/lib/hosts/hub";
import { loadPools, savePools, type HostPool } from "@/lib/hosts/pools";
import { createHost, HostRegistryUnreadableError, readHosts, revokeHost, UnknownHostError, updateHost, type HostRecord } from "@/lib/hosts/registry";
import { isRecord } from "@/lib/type-guards";

const MAX_LABEL_LENGTH = 100;
const noStore = { "cache-control": "no-store" };

const fail = (error: string, status: number) => Response.json({ error }, { status, headers: noStore });
const poolStorageFailure = () => fail("The pool registry (tau/pools.json) cannot be read or written; fix it before changing pools", 503);

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function failFor(error: unknown) {
  if (error instanceof HostRegistryUnreadableError) {
    return fail("The linked-hosts registry (tau/hosts.json) cannot be read; fix or remove it before changing hosts", 503);
  }
  if (error instanceof UnknownHostError) return fail("Unknown host", 404);
  throw error;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** `undefined` when absent, `null` when invalid. */
function parseLabel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= MAX_LABEL_LENGTH ? label : null;
}

/** Where a daemon should dial: the origin the browser used, through a reverse proxy if there is one. */
function requestOrigin(req: Request): string {
  const first = (name: string) => req.headers.get(name)?.split(",")[0]?.trim() || null;
  const own = new URL(req.url);
  const proto = first("x-forwarded-proto") ?? own.protocol.slice(0, -1);
  const host = first("x-forwarded-host") ?? req.headers.get("host") ?? own.host;
  try {
    const url = new URL(`${proto}://${host}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : own.origin;
  } catch {
    return own.origin;
  }
}

export function GET() {
  let pools: HostPool[];
  try {
    pools = loadPools();
  } catch {
    return poolStorageFailure();
  }
  return Response.json({ ...hostsSnapshot(), pools }, { headers: noStore });
}

export async function PUT(req: Request) {
  const body = await readBody(req);
  if (!hasOnlyKeys(body, ["pools"]) || !Array.isArray(body.pools)) return fail("pools must be an array", 400);
  let hosts: HostRecord[];
  try {
    hosts = readHosts();
  } catch (error) {
    return failFor(error);
  }
  const knownHosts = new Set(["local", ...hosts.map((host) => host.id)]);
  for (const pool of body.pools) {
    if (!hasOnlyKeys(pool, ["id", "label", "enabled", "members", "projects"])
      || !Array.isArray(pool.members) || !Array.isArray(pool.projects)) return fail("Invalid pool configuration", 400);
    for (const member of pool.members) {
      if (!hasOnlyKeys(member, ["hostId", "projectsRoot", "provisioned", "draining"])
        || typeof member.hostId !== "string" || !knownHosts.has(member.hostId)) return fail("Invalid or unknown pool member", 400);
    }
    for (const project of pool.projects) {
      if (!hasOnlyKeys(project, ["id", "name", "origin", "defaultRef", "clonePaths", "addedAt", "hidden", "alias", "sortOrder", "pinOrder", "launchConfig"])
        || (project.launchConfig !== undefined && !hasOnlyKeys(project.launchConfig, ["profile", "advisor", "extraArgs"]))) {
        return fail("Invalid pool project configuration", 400);
      }
    }
  }
  // A damaged registry is never replaced: fix it first.
  try {
    loadPools();
  } catch {
    return poolStorageFailure();
  }
  const after = body.pools as HostPool[];
  try {
    savePools(after);
  } catch (error) {
    // Core validation precedes persistence; filesystem errors carry an errno code.
    if (isRecord(error) && typeof error.code === "string") return poolStorageFailure();
    return fail("Invalid pool configuration", 400);
  }
  notifyHostsChange();
  return Response.json({ pools: after }, { headers: noStore });
}

export async function POST(req: Request) {
  const body = await readBody(req);
  const label = parseLabel(body?.label);
  if (!label) return fail(`label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`, 400);
  try {
    const { host, token } = createHost(label);
    notifyHostsChange();
    return Response.json(
      {
        host: listHosts().find((h) => h.id === host.id),
        token,
        command: `tau host login --url ${requestOrigin(req)}`,
      },
      { headers: noStore },
    );
  } catch (error) {
    return failFor(error);
  }
}

export async function PATCH(req: Request) {
  const body = await readBody(req);
  if (body && body.poolId !== undefined) return renamePool(body);
  if (!body || typeof body.id !== "string" || !body.id) return fail("id is required", 400);
  const isLocal = body.id === "local";
  if (isLocal && body.allowAgentStart !== undefined) return fail("This machine's agent-start setting cannot be changed", 400);
  // An empty name resets this machine to its default name.
  const label = isLocal && typeof body.label === "string" && !body.label.trim() ? "" : parseLabel(body.label);
  if (label === null) return fail(`label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`, 400);
  const { allowAgentStart } = body;
  if (allowAgentStart !== undefined && typeof allowAgentStart !== "boolean") return fail("allowAgentStart must be a boolean", 400);
  if (label === undefined && allowAgentStart === undefined) return fail("Nothing to update", 400);
  try {
    updateHost(body.id, { label, allowAgentStart });
    notifyHostsChange();
    return Response.json({ host: hostsSnapshot().hosts.find((h) => h.id === body.id) }, { headers: noStore });
  } catch (error) {
    return failFor(error);
  }
}

/** `{ poolId, label }`: renames one pool (the cluster) without replacing the registry the way PUT does. */
function renamePool(body: Record<string, unknown>) {
  if (!hasOnlyKeys(body, ["poolId", "label"]) || typeof body.poolId !== "string") return fail("poolId and label are required", 400);
  const label = parseLabel(body.label);
  if (!label) return fail(`label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`, 400);
  let pools: HostPool[];
  try {
    pools = loadPools();
  } catch {
    return poolStorageFailure();
  }
  const pool = pools.find((candidate) => candidate.id === body.poolId);
  if (!pool) return fail("Unknown pool", 404);
  pool.label = label;
  try {
    savePools(pools);
  } catch {
    return poolStorageFailure();
  }
  notifyHostsChange();
  return Response.json({ pools }, { headers: noStore });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id is required", 400);
  if (id === "local") return fail("This machine cannot be revoked", 400);
  // An unreadable registry fails before the pools change: no member is removed while its record and link remain.
  try {
    readHosts();
  } catch (error) {
    return failFor(error);
  }
  // A member leaves the cluster first: once its record is gone, no row is left to remove it there.
  try {
    const pools = loadPools();
    if (isClusterMember(pools, id)) savePools(leaveCluster(pools, id));
  } catch {
    return poolStorageFailure();
  }
  try {
    // Registry first: with the record gone a daemon that redials gets 401 instead of reconnecting.
    if (!revokeHost(id)) return fail("Unknown host", 404);
    closeHostLink(id);
    notifyHostsChange();
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) {
    return failFor(error);
  }
}
