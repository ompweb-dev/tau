// Wire contract for the multiplexed live-event stream (`/api/events`).
//
// Browsers cap HTTP/1.1 connections at 6 per host across ALL tabs, and every
// long-lived SSE response pins one of them. One tab used to hold up to three
// (running badges, the attached chat, the watched file), so three tabs froze
// every other request. Now one SharedWorker per browser holds a single
// `/api/events` stream and multiplexes every tab's subscriptions over it.
//
// Stream framing (SSE):
//   event: mux      data: MuxControlFrame       connection/subscription control
//   event: <subId>  data: <channel payload>     one subscription's frames
// Every frame also carries `id: <server ms at emit>`, read as `lastEventId`.
// Subscriptions are added/removed with POST /api/events (EventStreamRequest).
//
// Agent commands go as POST /api/agent/[id] and uploads over /api/uploads, from the tab.
//
// lib/event-stream-worker.ts imports this module (bundled by server/client-env.ts).

import { isValidNotificationId } from "./notification-events";
import type { DiagnosticStat } from "./transport-stats";

export const EVENT_STREAM_PATH = "/api/events";
export const MUX_CONTROL_EVENT = "mux";
/** Subscription ids double as SSE event names: no whitespace, never "mux"/"message". */
export const SUBSCRIPTION_ID_RE = /^s[0-9]{1,15}$/;
export const UNKNOWN_CONNECTION_CODE = "unknown_connection";

export type EventStreamChannel =
  | { kind: "running" }
  /** Notifications the server routes to the tab with this notification client id. */
  | { kind: "notifications"; clientId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "file"; path: string; hostId?: string; sessionId: string | null }
  /** Host tool calls (open_url, notify, open_file) from sessions no tab is watching. */
  | { kind: "host-tools" }
  /** Settings → Hosts: the `GET /api/hosts` body on subscribe and after every change. */
  | { kind: "hosts" };

/** The worker's answer to a `diag` poll (the right panel's Connection tab). Times are the browser's epoch ms. */
export interface ConnectionDiagnostics {
  /** `idle`: no connection intended; `down`: no connection for 15 s or more. */
  status: "idle" | "connected" | "connecting" | "down";
  /** When the current connection attempt or outage began; null while idle or connected. */
  since: number | null;
  lastReconnect: { at: number; trigger: string; outageMs: number } | null;
  /** Within `windowMs`. */
  reconnects: number;
  clockRttMs: number | null;
  effectiveType: string | null;
  windowMs: number;
  stats: DiagnosticStat[];
}

/** Commands whose successful reply does not confirm a pi round trip, so their reply times say nothing about pi:
 * answered by the web app itself when no pi child is alive (lib/agent-command.ts NO_SPAWN_REPLIES), or forwarded to
 * pi without awaiting its reply (lib/rpc-manager.ts dispatchCommand). */
export const NO_PI_REPLY_COMMANDS: ReadonlySet<string> = new Set([
  "get_btw_history", "btw_cancel",
  "host_tool_result", "ui_response",
  "outbox_add", "outbox_remove", "outbox_scope",
]);

export type MuxControlFrame =
  | { type: "hello"; connectionId: string; serverId: string }
  | { type: "open"; sub: string }
  | { type: "end"; sub: string };

export type EventStreamRequest =
  | { connectionId: string; subscribe: { id: string; channel: EventStreamChannel } }
  | { connectionId: string; unsubscribe: string };

const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 8192;

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function parseEventStreamChannel(value: unknown): EventStreamChannel | null {
  if (!value || typeof value !== "object") return null;
  const channel = value as Record<string, unknown>;
  switch (channel.kind) {
    case "running":
      return { kind: "running" };
    case "notifications":
      return isValidNotificationId(channel.clientId) ? { kind: "notifications", clientId: channel.clientId } : null;
    case "host-tools":
      return { kind: "host-tools" };
    case "hosts":
      return { kind: "hosts" };
    case "session":
      return isBoundedString(channel.sessionId, MAX_ID_LENGTH) ? { kind: "session", sessionId: channel.sessionId } : null;
    case "file": {
      if (!isBoundedString(channel.path, MAX_PATH_LENGTH)) return null;
      const sessionId = channel.sessionId ?? null;
      if (sessionId !== null && !isBoundedString(sessionId, MAX_ID_LENGTH)) return null;
      if (channel.hostId !== undefined && !isBoundedString(channel.hostId, MAX_ID_LENGTH)) return null;
      return { kind: "file", path: channel.path, sessionId, ...(channel.hostId === undefined ? {} : { hostId: channel.hostId as string }) };
    }
    default:
      return null;
  }
}

export function parseEventStreamRequest(value: unknown): EventStreamRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (!isBoundedString(body.connectionId, MAX_ID_LENGTH)) return null;
  if (typeof body.unsubscribe === "string") {
    return SUBSCRIPTION_ID_RE.test(body.unsubscribe) ? { connectionId: body.connectionId, unsubscribe: body.unsubscribe } : null;
  }
  const subscribe = body.subscribe as Record<string, unknown> | undefined;
  if (!subscribe || typeof subscribe.id !== "string" || !SUBSCRIPTION_ID_RE.test(subscribe.id)) return null;
  const channel = parseEventStreamChannel(subscribe.channel);
  return channel ? { connectionId: body.connectionId, subscribe: { id: subscribe.id, channel } } : null;
}
