import { randomUUID } from "crypto";
import { filePathApiSegments } from "./file-paths";
import { hostsSnapshot, onHostsChange, onWorkspaceFile } from "./hosts/hub";
import { resolveWorkspaceHost } from "./api-utils";
import { isLinkUp } from "./hosts/host";
import { HostOpError } from "./hosts/link-protocol";
import type { WorkspaceFileEvent } from "./workspace-types";
import { attachNotificationClient } from "./notification-hub";
import { getExitedRpcSessions, getLiveRpcSession, getRunningRpcSessions, subscribeHostToolCalls, subscribeRunningSessions, type AgentSessionWrapper } from "./rpc-manager";
import { onOutboxChange, outboxEntries, outboxSnapshot } from "./message-outbox";
import { subscribeSessionFileChanges } from "./session-watcher";
import {
  MUX_CONTROL_EVENT,
  UNKNOWN_CONNECTION_CODE,
  type EventStreamChannel,
  type MuxControlFrame,
} from "./event-stream-protocol";
import { isDeltaUpdate, mergeDeltaUpdates } from "./message-delta";
import { isRecord } from "./type-guards";

// Server half of the multiplexed live-event stream (see event-stream-protocol).
// One EventStreamConnection = one `/api/events` SSE response = one browser
// socket, carrying any number of channel subscriptions for every tab behind
// the browser's shared worker.

// Heartbeat keeps the socket alive through reverse proxies that drop silent connections.
// A native client may ask for a longer one per connection (`/api/events?heartbeat=`).
const HEARTBEAT_MS = 30_000;
export const MIN_HEARTBEAT_SECONDS = 15;
export const MAX_HEARTBEAT_SECONDS = 110;

/** `?heartbeat=<seconds>` in [15, 110]; anything else keeps the 30 s default. */
export function parseHeartbeatSeconds(value: string | null | undefined): number {
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value.trim())) return HEARTBEAT_MS / 1000;
  const seconds = Number(value.trim());
  if (seconds < MIN_HEARTBEAT_SECONDS || seconds > MAX_HEARTBEAT_SECONDS) return HEARTBEAT_MS / 1000;
  return seconds;
}

const encoder = new TextEncoder();

export type SubscribeResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string };

const SUBSCRIBED: SubscribeResult = { ok: true };

/**
 * The floor between two `tool_execution_update` snapshots of one tool in one
 * session subscription. pi sends the accumulated tool output on every update,
 * so a bash run printing megabytes would otherwise forward the whole buffer
 * many times per second. Each frame is a self-contained snapshot of one
 * `toolCallId`, so holding the newest one per tool is lossless and concurrent
 * tools never supersede each other; a boundary frame (`tool_execution_end`,
 * `message_end`, …) always flushes them first, in emission order, so the final
 * output is never delayed. Message deltas are not throttled: they are
 * incremental since the delta protocol, and — because a held snapshot is not in
 * the message queue — they neither wait for one nor release one.
 */
export const TOOL_UPDATE_FRAME_MIN_INTERVAL_MS = 1_000;

class Subscription {
  active = true;
  detach: (() => void) | null = null;
  // Message and outbox updates plus boundary frames, in emission order: message
  // updates merge and consecutive outbox snapshots replace each other. Tool
  // snapshots are held OUTSIDE this queue (see `heldToolUpdates`), so a held
  // snapshot can neither delay a queued frame nor be released by one.
  pendingUpdates: QueuedFrame[] = [];
  /**
   * The newest snapshot of each tool, keyed by `toolCallId`, held until its
   * window opens. It needs no position among the message frames: the browser
   * fences a tool frame by the tool and lifecycle sequences, never by the
   * message sequence (`hooks/useAgentSession-sync.ts`). `seq` is the emission
   * counter of the frame it holds, so a boundary flush can merge it back into
   * the queue in the order it was emitted.
   */
  heldToolUpdates = new Map<string, HeldToolUpdate>();
  /** When the last snapshot of each tool was written (absent = never written). */
  lastToolUpdateAt = new Map<string, number>();
  /** Monotonic emission counter: orders held snapshots against queued frames. */
  emitCount = 0;
  /** The one timer that releases held frames once their window elapsed. */
  drainTimer: NodeJS.Timeout | undefined = undefined;
  /** Deadline of `drainTimer`; a newer frame may pull it forward. */
  drainAt = 0;

  constructor(readonly id: string, readonly throttlesAgentUpdates: boolean) {}

  /** Drop held frames and their timer (unsubscribe, end, close). */
  clearUpdates(): void {
    this.pendingUpdates = [];
    this.heldToolUpdates.clear();
    this.lastToolUpdateAt.clear();
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.drainAt = 0;
  }
}

/** What a channel opener may do with its subscription. */
interface SubscriptionHandle {
  readonly active: boolean;
  /** Announce the subscription; must precede any `send`. */
  open(): void;
  send(data: unknown): void;
  /** Server-initiated end; the client re-subscribes like an EventSource reconnect. */
  end(): void;
  /** Register teardown. Runs immediately if the subscription already ended. */
  setDetach(detach: () => void): void;
}

declare global {
  var __tauEventStreamConnections: Map<string, EventStreamConnection> | undefined;
  var __tauServerId: string | undefined;
}

/** Random per process: a reconnecting client compares it to learn whether the server restarted. */
export function serverId(): string {
  return (globalThis.__tauServerId ??= randomUUID());
}

/** Where a connection's frames go: an SSE response body (tests supply their own). */
export interface FrameSink {
  /** Send one frame; false means the peer is gone and the connection closes. */
  write(name: string, at: number, data: string): boolean;
  /** The peer is behind: replaceable updates coalesce until the owner calls `resume()`. */
  backpressured(): boolean;
  /** Keep-alive; false means the peer is gone. */
  heartbeat(): boolean;
  readonly heartbeatMs: number;
  close(): void;
}

class SseSink implements FrameSink {
  readonly heartbeatMs: number;
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor(onPull: () => void, onCancel: () => void, heartbeatMs = HEARTBEAT_MS) {
    this.heartbeatMs = heartbeatMs;
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller; },
      // A slow consumer resumed reading: deliver coalesced updates now rather
      // than waiting for the next event or heartbeat.
      pull: onPull,
      // Half-open disconnects may never fire the abort signal.
      cancel: onCancel,
    });
  }

  write(name: string, at: number, data: string): boolean {
    return this.enqueue(`event: ${name}\nid: ${at}\ndata: ${data}\n\n`);
  }

  heartbeat(): boolean {
    return this.enqueue(":\n\n");
  }

  backpressured(): boolean {
    return (this.controller.desiredSize ?? 0) < 0;
  }

  close(): void {
    try { this.controller.close(); } catch { /* already closed */ }
  }

  private enqueue(text: string): boolean {
    try {
      this.controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      return false;
    }
  }
}

function connections(): Map<string, EventStreamConnection> {
  return (globalThis.__tauEventStreamConnections ??= new Map());
}

export function getEventStreamConnection(connectionId: string): EventStreamConnection | undefined {
  return connections().get(connectionId);
}

function runDetach(detach: (() => void) | null): void {
  if (!detach) return;
  try { detach(); } catch { /* a failing unsubscribe must not block teardown */ }
}

export class EventStreamConnection {
  readonly id = randomUUID();
  /** The SSE response body; null when the caller supplied its own sink. */
  readonly stream: ReadableStream<Uint8Array> | null;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly sink: FrameSink;
  private closed = false;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly signal: AbortSignal | undefined;

  /** `options.heartbeatMs` overrides the keep-alive for this connection's SSE sink. */
  constructor(signal?: AbortSignal, sink?: FrameSink | { heartbeatMs?: number }) {
    this.signal = signal;
    if (sink && "write" in sink) {
      this.sink = sink;
      this.stream = null;
    } else {
      const sse = new SseSink(() => this.resume(), () => this.close(), sink?.heartbeatMs ?? HEARTBEAT_MS);
      this.sink = sse;
      this.stream = sse.stream;
    }
    connections().set(this.id, this);
    this.control({ type: "hello", connectionId: this.id, serverId: serverId() });
    if (!this.closed) {
      this.heartbeat = setInterval(() => {
        if (this.flushAll() && !this.sink.heartbeat()) this.close();
      }, this.sink.heartbeatMs);
    }
    signal?.addEventListener("abort", this.close);
    if (signal?.aborted) this.close();
  }

  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const subscription of this.subscriptions.values()) this.release(subscription);
    this.subscriptions.clear();
    connections().delete(this.id);
    this.signal?.removeEventListener("abort", this.close);
    this.sink.close();
  };

  get isClosed(): boolean {
    return this.closed;
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  async subscribe(id: string, channel: EventStreamChannel): Promise<SubscribeResult> {
    if (this.closed) return { ok: false, status: 404, error: "Unknown event stream connection", code: UNKNOWN_CONNECTION_CODE };
    this.unsubscribe(id);
    const subscription = new Subscription(id, channel.kind === "session");
    this.subscriptions.set(id, subscription);
    const handle: SubscriptionHandle = {
      get active() { return subscription.active; },
      open: () => { this.control({ type: "open", sub: id }); },
      send: (data) => this.deliver(subscription, data),
      end: () => this.end(subscription),
      setDetach: (detach) => {
        if (subscription.active) subscription.detach = detach;
        else runDetach(detach);
      },
    };
    let result: SubscribeResult;
    try {
      result = await openChannel(channel, handle);
    } catch (error) {
      result = { ok: false, status: 500, error: String(error), code: "subscribe_failed" };
    }
    if (!result.ok && this.subscriptions.get(id) === subscription) {
      this.subscriptions.delete(id);
      this.release(subscription);
    }
    return result;
  }

  unsubscribe(id: string): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    this.release(subscription);
  }

  private release(subscription: Subscription): void {
    subscription.active = false;
    subscription.clearUpdates();
    const detach = subscription.detach;
    subscription.detach = null;
    runDetach(detach);
  }

  private end(subscription: Subscription): void {
    if (!subscription.active) return;
    if (this.subscriptions.get(subscription.id) === subscription) this.subscriptions.delete(subscription.id);
    this.release(subscription);
    this.control({ type: "end", sub: subscription.id });
  }

  private write(name: string, data: string, at = Date.now()): boolean {
    if (this.closed) return false;
    if (this.sink.write(name, at, data)) return true;
    this.close();
    return false;
  }

  control(frame: MuxControlFrame): void {
    this.write(MUX_CONTROL_EVENT, JSON.stringify(frame));
  }

  private writeFrame(subscription: Subscription, data: unknown, at?: number): boolean {
    let text: string;
    try {
      text = JSON.stringify(data);
    } catch {
      // An unserializable frame (e.g. a circular UI replay) ends only its own
      // subscription, never the shared socket other tabs depend on.
      this.end(subscription);
      return false;
    }
    return this.write(subscription.id, text, at);
  }

  /** The peer drained: deliver queued frames now rather than waiting for the next event or heartbeat. */
  resume(): void {
    this.flushAll();
  }

  private flushAll(): boolean {
    for (const subscription of this.subscriptions.values()) {
      if (!this.drainAndReschedule(subscription)) return false;
    }
    return !this.closed;
  }

  /**
   * Write the message/outbox queue in emission order, then release every held
   * tool snapshot whose window has opened. A held snapshot never blocks a
   * queued frame and a queued frame never releases a held snapshot: the two are
   * independent, which is what makes the throttle hold under a streaming turn
   * (deltas arrive constantly) and keeps one tool's window from delaying
   * another tool's snapshot.
   *
   * `force` (a boundary frame is waiting) writes the queued frames without
   * regard to backpressure, because the frame that follows must not be delayed;
   * a boundary flush merges the held snapshots into the queue first, in
   * emission order, so the end frame never overtakes the output it ends. The
   * heartbeat retries through the non-force path, so it never overrides
   * backpressure; a snapshot released by its own window is written only while
   * the sink has capacity.
   *
   * A tool snapshot is stamped with the time it is actually written, not the
   * time it was emitted: the deliberate hold must not read as network latency.
   */
  private drain(subscription: Subscription, force = false): boolean {
    // A stamp whose window elapsed is useless: a later snapshot is writable at once.
    for (const [toolCallId, at] of subscription.lastToolUpdateAt) {
      if (Date.now() - at >= TOOL_UPDATE_FRAME_MIN_INTERVAL_MS) subscription.lastToolUpdateAt.delete(toolCallId);
    }
    // Detach the queue before writing: `writeFrame` can release the peer
    // synchronously (a stream pull calls `resume()`, which drains every
    // subscription), and that re-entrant drain must see an empty queue rather
    // than write the frames this loop still holds a second time.
    const queue = subscription.pendingUpdates;
    subscription.pendingUpdates = [];
    let written = 0;
    while (written < queue.length) {
      if (!force && this.sink.backpressured()) break;
      const frame = queue[written];
      written += 1;
      if (!this.writeFrame(subscription, frame.data, frame.tool ? Date.now() : frame.at)) return !this.closed;
    }
    // Frames appended while writing stay behind the ones still to write.
    if (written < queue.length) subscription.pendingUpdates = queue.slice(written).concat(subscription.pendingUpdates);
    if (this.sink.backpressured()) return !this.closed;
    // Release what the windows allow. Ordering is required per tool, not across
    // tools: two independent tools may be written in either order, so the emit
    // order here is deterministic, not a consumer dependency.
    const releasable = [...subscription.heldToolUpdates.entries()]
      .filter(([toolCallId]) => Date.now() >= (subscription.lastToolUpdateAt.get(toolCallId) ?? 0) + TOOL_UPDATE_FRAME_MIN_INTERVAL_MS)
      .sort(([, a], [, b]) => a.seq - b.seq);
    for (const [toolCallId, held] of releasable) {
      // Each write can fill the sink: the rest stay held for resume().
      if (!force && this.sink.backpressured()) break;
      // A sink whose write re-enters `drain()` may already have released and
      // written this entry from the live map: stop at the current value, never
      // write a stale iteration snapshot a second time.
      if (subscription.heldToolUpdates.get(toolCallId) !== held) continue;
      subscription.heldToolUpdates.delete(toolCallId);
      const stamp = Date.now();
      subscription.lastToolUpdateAt.set(toolCallId, stamp);
      if (!this.writeFrame(subscription, held.data, stamp)) return !this.closed;
    }
    return !this.closed;
  }

  /** Drain what is ready, then arm the one timer for the next held snapshot. */
  private drainAndReschedule(subscription: Subscription, force = false): boolean {
    if (!this.drain(subscription, force)) return false;
    if (!subscription.active || this.closed) return !this.closed;
    if (subscription.heldToolUpdates.size === 0) {
      clearTimeout(subscription.drainTimer);
      subscription.drainTimer = undefined;
      subscription.drainAt = 0;
      return true;
    }
    // The sink's owner calls `resume()` once it has capacity again, and the
    // heartbeat retries: a timer here would only spin while the peer is behind.
    if (this.sink.backpressured()) return true;
    let earliest = Infinity;
    for (const toolCallId of subscription.heldToolUpdates.keys()) {
      const at = subscription.lastToolUpdateAt.get(toolCallId) ?? 0;
      earliest = Math.min(earliest, at + TOOL_UPDATE_FRAME_MIN_INTERVAL_MS);
    }
    this.scheduleDrain(subscription, Math.max(earliest - Date.now(), 1));
    return true;
  }

  /**
   * Arm the timer that releases held frames. A newer frame only pulls the
   * deadline forward, never pushes it back.
   */
  private scheduleDrain(subscription: Subscription, delayMs: number): void {
    if (!subscription.active || this.closed) return;
    const deadline = Date.now() + delayMs;
    if (subscription.drainTimer !== undefined && subscription.drainAt <= deadline) return;
    clearTimeout(subscription.drainTimer);
    subscription.drainAt = deadline;
    subscription.drainTimer = setTimeout(() => {
      subscription.drainTimer = undefined;
      subscription.drainAt = 0;
      if (!subscription.active || this.closed) return;
      this.drainAndReschedule(subscription);
    }, delayMs);
    // A throttle window must not keep the process alive.
    subscription.drainTimer.unref?.();
  }

  /**
   * Move every held snapshot into the message queue, in the order it was
   * emitted. Used when a boundary frame arrives: it must not overtake output
   * that was emitted before it, and the queue is the one place a drain writes
   * in order.
   */
  private releaseHeldToolUpdates(subscription: Subscription): void {
    if (subscription.heldToolUpdates.size === 0) return;
    const held = [...subscription.heldToolUpdates.entries()].sort(([, a], [, b]) => a.seq - b.seq);
    subscription.heldToolUpdates.clear();
    for (const [toolCallId, update] of held) {
      // `tool: true` makes the drain stamp the write time, not this release time.
      subscription.pendingUpdates.push({ data: update.data, at: Date.now(), tool: true });
      subscription.lastToolUpdateAt.set(toolCallId, Date.now());
    }
  }

  private deliver(subscription: Subscription, data: unknown): void {
    if (!subscription.active || this.closed) return;
    // Other channels never queue: their frames are neither throttled nor merged.
    if (!subscription.throttlesAgentUpdates) {
      this.writeFrame(subscription, data);
      return;
    }
    if (isRecord(data)) {
      if (data.type === "tool_execution_update" && typeof data.toolCallId === "string" && data.toolCallId) {
        // Held outside the message queue: the browser fences a tool frame by
        // its tool/lifecycle sequences, never by `messageSequence`, so it needs
        // no position among the deltas. The newest snapshot per tool wins.
        subscription.heldToolUpdates.set(data.toolCallId, { data, seq: ++subscription.emitCount });
        this.drainAndReschedule(subscription);
        return;
      }
      if (data.type === "outbox_update" || data.type === "message_update") {
        // Nothing waits: the frame goes out at once, and it never releases a
        // held tool snapshot (that would defeat the throttle).
        if (subscription.pendingUpdates.length === 0 && subscription.heldToolUpdates.size === 0 && !this.sink.backpressured()) {
          this.writeFrame(subscription, data);
          return;
        }
        queueUpdate(subscription.pendingUpdates, data, Date.now());
        this.drainAndReschedule(subscription);
        return;
      }
    }
    // Every other frame is a boundary (`tool_execution_end`, `message_end`, …):
    // everything emitted before it must reach the client first, in order. The
    // held snapshots were emitted before it too, so they join the queue ahead
    // of it — in their own emission order — and the forced drain writes all of
    // it without regard to backpressure.
    this.releaseHeldToolUpdates(subscription);
    subscription.pendingUpdates.push({ data, at: Date.now() });
    this.drainAndReschedule(subscription, true);
  }
}

/**
 * One queued frame. `at` is the emit time, so the stamp keeps measuring
 * server-to-peer delay — except for a tool snapshot released by a boundary
 * frame, which is stamped when it is written (`tool`): the deliberate hold must
 * not read as network latency in Connection diagnostics.
 */
type QueuedFrame = { data: unknown; at: number; tool?: boolean };

/**
 * The newest snapshot of one tool, held until its window opens. Each frame
 * carries the tool's whole accumulated output, so a newer snapshot supersedes
 * the held one losslessly. `seq` orders it against the other held snapshots
 * when a boundary frame flushes them all.
 */
type HeldToolUpdate = { data: Record<string, unknown>; seq: number };

/**
 * Merge a `message_update` into a backpressure queue without losing anything:
 * a whole message replaces the queued updates of that message (it holds them
 * all), and a delta joins the last queued delta of the same block. Each entry
 * keeps the emit time and sequence of its latest frame (and `web.first`, its
 * first piece's), so the stamp keeps measuring server-to-peer delay and
 * sequences stay in order. Deltas interleaved across blocks do not merge:
 * joining a delta to an earlier entry would put it before frames it follows
 * and break the sequence fence the browser relies on.
 */
function queueUpdate(queue: QueuedFrame[], data: Record<string, unknown>, at: number): void {
  const last = queue.at(-1);
  const lastData = last && isRecord(last.data) ? last.data : null;
  if (data.type === "outbox_update") {
    if (last && lastData?.type === "outbox_update") {
      last.data = data;
      last.at = at;
    } else {
      queue.push({ data, at });
    }
    return;
  }
  if (!isDeltaUpdate(data)) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const frame = queue[i];
      if (!isRecord(frame.data)) continue;
      if (frame.data.type === "outbox_update") break;
      if (frame.data.messageId === data.messageId) queue.splice(i, 1);
    }
    queue.push({ data, at });
    return;
  }
  const merged = lastData && isDeltaUpdate(lastData) ? mergeDeltaUpdates(lastData, data) : null;
  if (last && merged) {
    last.data = merged;
    last.at = at;
  } else {
    queue.push({ data, at });
  }
}

async function openChannel(channel: EventStreamChannel, handle: SubscriptionHandle): Promise<SubscribeResult> {
  switch (channel.kind) {
    case "running":
      return openRunningChannel(handle);
    case "notifications":
      return openNotificationsChannel(channel.clientId, handle);
    case "session":
      return openSessionChannel(channel.sessionId, channel.hostId, handle);
    case "file":
      return openFileChannel(channel.path, channel.sessionId, channel.hostId, handle);
    case "host-tools":
      return openHostToolsChannel(handle);
    case "hosts":
      return openHostsChannel(handle);
  }
}

// Running-session ids plus session-list refresh hints for the sidebar.
function openRunningChannel(handle: SubscriptionHandle): SubscribeResult {
  handle.open();
  // Subscribe BEFORE taking the initial snapshot so no state change can slip
  // through the gap between snapshot and subscription.
  const unsubscribeRunning = subscribeRunningSessions(({ runningSessions, exitedSessions, refreshSessionList }) => {
    handle.send({
      type: "running",
      runningSessions,
      exitedSessions,
      ...(refreshSessionList ? { refreshSessionList: true } : {}),
    });
  });
  const unsubscribeFiles = subscribeSessionFileChanges((sessionIds) => {
    handle.send({ type: "sessions-changed", sessionIds, refreshSessionList: true });
  });
  handle.setDetach(() => {
    unsubscribeRunning();
    unsubscribeFiles();
  });
  const initialRunning = getRunningRpcSessions();
  handle.send({
    type: "running",
    runningSessions: initialRunning,
    exitedSessions: getExitedRpcSessions(),
  });
  return SUBSCRIBED;
}

// The notifications the server routes to one tab (`clientId`). The tab counts
// as reachable for toasts and in-page system notifications while this is open.
function openNotificationsChannel(clientId: string, handle: SubscriptionHandle): SubscribeResult {
  handle.open();
  handle.setDetach(attachNotificationClient(clientId, (message) => {
    // A retraction is its own frame type: the client's notification branch
    // accepts only the toast/os kinds, so a wrapped dismiss would be dropped.
    if (message.kind === "dismiss") {
      handle.send({ type: "notification-dismiss", tag: message.tag, sessionId: message.sessionId, requestId: message.requestId });
      return;
    }
    handle.send({ type: "notification", ...message });
  }));
  return SUBSCRIBED;
}

// Host tool calls from sessions no tab is watching: every tab holds one, so a
// session keeps its host tools while the user views another.
function openHostToolsChannel(handle: SubscriptionHandle): SubscribeResult {
  handle.open();
  handle.setDetach(subscribeHostToolCalls((call) => handle.send({ type: "host_tool_call", ...call })));
  return SUBSCRIBED;
}

// Settings → Hosts: the linked-hosts list on subscribe and after every change.
function openHostsChannel(handle: SubscriptionHandle): SubscribeResult {
  handle.open();
  // Snapshots are built one at a time so frames never arrive out of order.
  let chain: Promise<void> = Promise.resolve();
  const push = () => {
    chain = chain
      .then(() => {
        const snapshot = hostsSnapshot();
        if (handle.active) handle.send(snapshot);
      })
      .catch(() => {});
  };
  handle.setDetach(onHostsChange(push));
  push();
  return SUBSCRIBED;
}

// Agent events of one live pi wrapper, and the session's held messages (`outbox_update`, lib/message-outbox.ts).
function openSessionChannel(sessionId: string, hostId: string | undefined, handle: SubscriptionHandle): SubscribeResult {
  // Observer-only: opening a saved session must not create another pi
  // process for a terminal-owned session. Explicit commands use
  // POST /api/agent/[id], which starts the wrapper before this attaches.
  // Without a host, a live copy: a dead wrapper here must not hide one elsewhere.
  let session = getLiveRpcSession(sessionId, hostId);
  // Held messages show before pi runs (a host offline): the channel attaches to the wrapper the dispatcher starts.
  // The held messages of this host's copy only (every host's without one): the same id on another host is another session.
  if (!session && outboxEntries(sessionId, hostId).length === 0) {
    return { ok: false, status: 409, error: "Session is not managed by tau", code: "session_not_managed" };
  }

  handle.open();
  let detachSession = () => {};
  const attach = (live: AgentSessionWrapper) => {
    // onEvent can synchronously replay pending UI requests. Subscribe before
    // sampling the cursor/announcing readiness so catch-up has no event gap.
    detachSession = live.onEvent((event) => handle.send(event));
    handle.send({ type: "connected", sessionId, web: live.getStreamSnapshot().cursor });
  };
  if (session) attach(session);
  // A hostless subscription is pinned to the host of the first copy it attaches: it never switches to another host's
  // session of the same id.
  let boundHost = hostId ?? session?.host?.id;
  const rebind = (announceBind = true) => {
    const unbound = boundHost === undefined;
    const live = getLiveRpcSession(sessionId, boundHost);
    boundHost ??= live?.host?.id;
    if (live !== session) {
      detachSession();
      detachSession = () => {};
      session = live;
      if (live) attach(live);
    }
    // Binding narrows the every-host snapshot sent before it to the bound copy's held messages.
    if (announceBind && unbound && boundHost !== undefined && handle.active) handle.send({ type: "outbox_update", ...outboxSnapshot(sessionId, boundHost) });
  };
  const detachRunning = subscribeRunningSessions(() => rebind());
  const detachOutbox = onOutboxChange(sessionId, hostId, () => {
    rebind(false);
    // A hostless channel shows the bound copy's held messages once a copy binds; every host's before that.
    handle.send({ type: "outbox_update", ...outboxSnapshot(sessionId, boundHost) });
  });
  rebind(false);
  handle.setDetach(() => {
    detachOutbox();
    detachRunning();
    detachSession();
  });
  if (handle.active) handle.send({ type: "outbox_update", ...outboxSnapshot(sessionId, boundHost) });
  return SUBSCRIBED;
}

// Change notifications for one file open in the viewer.
async function openFileChannel(rawPath: string, sessionId: string | null, hostId: string | undefined, handle: SubscriptionHandle): Promise<SubscribeResult> {
  const resolved = await resolveWorkspaceHost(hostId, sessionId);
  if ("response" in resolved) {
    const body = await resolved.response.json();
    return { ok: false, status: resolved.response.status, error: body.error, code: body.code };
  }
  const { host } = resolved;
  const id = randomUUID(), epoch = randomUUID();
  let opened = false;
  const pending: WorkspaceFileEvent[] = [];
  const detachEvent = onWorkspaceFile(host.id, id, epoch, (event) => {
    if (!handle.active) return;
    if (!opened) { pending.push(event); return; }
    handle.send(event);
    if (event.type === "error") handle.end();
  });
  const detachStatus = host.onStatus((status) => { if (!isLinkUp(status)) handle.end(); });
  handle.setDetach(() => {
    detachEvent(); detachStatus();
    void host.workspaceOps.unwatchFile(id, epoch).catch(() => {});
  });
  try {
    const result = await host.workspaceOps.watchFile(id, epoch, { segments: filePathApiSegments(rawPath), sessionId: resolved.sessionId, sessionFile: resolved.sessionFile, owner: resolved.owner });
    if (!result.ok) { detachEvent(); detachStatus(); return result; }
    if (!handle.active) { void host.workspaceOps.unwatchFile(id, epoch).catch(() => {}); return SUBSCRIBED; }
    const info = result.value;
    handle.open();
    // A new watch epoch always refreshes bytes missed during the disconnected interval.
    handle.send({ type: "change", mtime: new Date(info.mtimeMs).toISOString(), size: info.size });
    handle.send({ type: "connected", filePath: info.path });
    opened = true;
    for (const event of pending) { handle.send(event); if (event.type === "error") handle.end(); }
    return SUBSCRIBED;
  } catch (error) {
    detachEvent(); detachStatus();
    if (error instanceof HostOpError) return { ok: false, status: error.status, code: error.code, error: error.message };
    throw error;
  }
}
