/** Server key of one host's copy of a session id: the same id on two hosts is two sessions. Host ids never contain "/". */
export function sessionHostKey(hostId: string, id: string): string {
  return `${hostId}/${id}`;
}

/** The host and id of a `sessionHostKey`. */
export function splitSessionHostKey(key: string): { hostId: string; id: string } {
  const slash = key.indexOf("/");
  return { hostId: key.slice(0, slash), id: key.slice(slash + 1) };
}
