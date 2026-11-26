import { isValidNotificationId } from "@/lib/notification-events";
import { reportPresence } from "@/lib/notification-hub";
import { isRecord } from "@/lib/type-guards";

/** More chats than any screen shows at once: a report naming more keeps the first ones. */
const MAX_SHOWN_SESSIONS = 32;

/** POST /api/notifications/presence { clientId, deviceId, visible, sessionIds, seq } — which sessions this tab shows. */
export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (
    !isRecord(body) || !isValidNotificationId(body.clientId) || !isValidNotificationId(body.deviceId)
    || typeof body.visible !== "boolean" || !Number.isSafeInteger(body.seq)
    || !Array.isArray(body.sessionIds) || body.sessionIds.length > 1000
    || !body.sessionIds.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)
  ) {
    return Response.json({ error: "Invalid presence report", code: "invalid_presence" }, { status: 400 });
  }
  reportPresence({ clientId: body.clientId, deviceId: body.deviceId, visible: body.visible, sessionIds: body.sessionIds.slice(0, MAX_SHOWN_SESSIONS), seq: Number(body.seq) });
  return new Response(null, { status: 204 });
}
