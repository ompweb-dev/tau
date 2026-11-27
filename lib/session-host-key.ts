/** Server key of one host's copy of a session id: the same id on two hosts is two sessions. Host ids never contain "/". */
export function sessionHostKey(hostId: string, id: string): string {
  return `${hostId}/${id}`;
}
