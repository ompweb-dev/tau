import { handleLinkUpgrade, type LinkSocketData } from "@/lib/hosts/hub";

// The `tau host` daemon's link (lib/hosts/hub.ts). proxy.ts does not run
// for this path: the hub checks the host's bearer token before it upgrades.

// GET /api/hosts/link — the link's WebSocket; undefined once upgraded (server/app.ts).
export function GET(req: Request, { upgrade }: { upgrade: (data: LinkSocketData) => boolean }) {
  return handleLinkUpgrade(req, upgrade);
}
