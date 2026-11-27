// Import-free leaf: the server, the browser and the event-stream worker use it (public/sw.js keeps copies).

/** Key of one host's copy of a session id, everywhere (server state, drafts, marks, notifications): the same id on
 *  two hosts is two sessions. No host = this machine. Host ids never contain "/". */
export function sessionHostKey(hostId: string | null | undefined, id: string): string {
  return `${hostId ?? "local"}/${id}`;
}

/** The host and id of a `sessionHostKey`. */
export function splitSessionHostKey(key: string): { hostId: string; id: string } {
  const slash = key.indexOf("/");
  return { hostId: key.slice(0, slash), id: key.slice(slash + 1) };
}

/** /api/agent/[id], for one host's copy when `hostId` is given; without it the server resolves the host. */
export function agentUrl(sessionId: string, hostId?: string): string {
  return `/api/agent/${encodeURIComponent(sessionId)}${hostId ? `?hostId=${encodeURIComponent(hostId)}` : ""}`;
}
