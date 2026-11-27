// tau live-event multiplexer.
//
// Runs as a SharedWorker (one per browser profile) — or a dedicated Worker where SharedWorker is unavailable — and
// carries every tab's stream (lib/event-stream.ts) as a subscription on its one connection, so opening more tabs no
// longer consumes more of the browser's six HTTP/1.1 connections per host: the ONLY `/api/events` EventSource, whose
// subscriptions POST /api/events adds. Tabs POST their agent commands and uploads themselves.
//
// Bundled by server/client-env.ts (buildEventStreamWorker) into a classic script; lib/event-stream-worker.test.mjs runs
// it in node:vm with fake browser globals.
//
// It also owns the browser's message outbox (docs/specs/2026-11-04-message-outbox-design.md O2): IndexedDB
// `tau-outbox`, sent as `outbox_add` agent commands until the server has stored each (public/sw.js reads it too).
//
// Tab -> worker:  { op: "open", id, channel } | { op: "close", id }
//                 { op: "lock", name }  (tab holds this Web Lock while alive)
//                 { op: "bye" }         (pagehide: drop this tab's streams)
//                 { op: "wake", reason, visible, clientId }  (reason: init | visible | hidden | online | network)
//                 { op: "metric", sample }  (a transport sample of the tab's: tagged, buffered and POSTed here)
//                 { op: "upload", id }  (the tab starts an upload under this id: a cancel still pending for it is dropped)
//                 { op: "up_abort", id, host }  (the tab removed it: the host deletes what it staged; kept until delivered)
//                 { op: "diag", n }  (the connection diagnostics panel's poll)
//                 { op: "outbox_add", n, entry }  (a message for the outbox: a LocalOutboxEntry without state/error)
//                 { op: "outbox_drop", n, id }  (remove a "failed" entry; the tab waits for its committed deletion)
// Worker -> tab:  { id, type: "open" }
//                 { id, type: "message", data }   (raw JSON string)
//                 { id, type: "error", readyState: 0 | 2 }  (EventSource semantics)
//                 { diag: n, data }  (ConnectionDiagnostics, lib/event-stream.ts)
//                 { outboxAdded: n, error?: string }  (committed to IndexedDB, or refused with error: keep the draft)
//                 { outboxDropped: n, error?: string }  (deletion committed, or refused: keep the bubble and draft)
//                 { outbox: LocalOutboxEntry[], partial?: true }  (every entry, in submission order: on attach once loaded
//                   if any, back from the bfcache, and on every change; partial: the last shared read failed, so earlier
//                   entries of other workers may be missing and the tab must not keepalive from it)
//                 { outboxStored: OutboxEntry & { replaces? } }  (the server stored one; the list without it follows)
import {
  EVENT_STREAM_PATH,
  MUX_CONTROL_EVENT,
  UNKNOWN_CONNECTION_CODE,
  type ConnectionDiagnostics,
  type EventStreamChannel,
} from "./event-stream-protocol";
import type { LocalOutboxEntry } from "./event-stream";
import { diagnosticStats } from "./transport-stats";
import { isRecord } from "./type-guards";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;
type ReadyState = typeof CONNECTING | typeof OPEN | typeof CLOSED;
// Mirrors EventSource's own reconnect delay after a server-ended stream.
const RESUBSCRIBE_DELAY_MS = 3000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Every tab forwards the same network or visibility event: wakes this close are one burst.
const WAKE_BURST_MS = 1000;
/** Connecting this long without a hello shows as `down` in the diagnostics. */
const DOWN_AFTER_MS = 15000;
/** The most up_aborts kept until delivered: past it the oldest goes (the host daemon's sweep of old staged files covers it). */
const ABORTS_MAX = 256;
/** An abort's DELETE that failed goes again after these (the last repeats), and at once on a wake. */
const ABORT_RETRY_MS = [5_000, 15_000, 60_000];
/** An abort's DELETE not answered in this long is abandoned and retried. */
const ABORT_DELETE_TIMEOUT_MS = 40_000;
// Transport samples (spec D6 of the experiment): POSTed in batches to the metrics route, whose GET is the SSE clock probe.
const METRICS_PATH = "/api/transport-metrics";
const METRICS_FLUSH_MS = 30000;
/** A metrics request (clock probe or sample POST) not answered in full by then is abandoned, so one hung request never
 * stops the probe chain or keeps `flushing` set. */
const METRICS_TIMEOUT_MS = 10000;
/** The slowest link a sample POST is given time for: 2 KB/s. The deadline is METRICS_TIMEOUT_MS plus the body over this. */
const METRICS_POST_BYTES_PER_MS = 2;
const METRICS_FLUSH_COUNT = 200;
const METRICS_BUFFER_MAX = 2000;
const EVENT_SAMPLE_MS = 1000;
const WAKE_WINDOW_MS = 60000;
const BATCH_WINDOW_MS = 2000;
const SSE_CLOCK_PROBES = 3;
// After those, one probe per this.
const SSE_CLOCK_PROBE_MS = 10000;
// The clock is the lowest-RTT of the last CLOCK_WINDOW_SAMPLES samples no older than CLOCK_WINDOW_MS (the newest always
// stays), so a device clock step ages out.
const CLOCK_WINDOW_MS = 300000;
const CLOCK_WINDOW_SAMPLES = 20;
const LARGE_FRAME_BYTES = 64 * 1024;
const LARGE_FRAME_LOG_MS = 30000;
/** The diagnostics panel's stats cover this browser's samples of this long, at most DIAGNOSTICS_MAX of them. */
const DIAGNOSTICS_WINDOW_MS = 30 * 60_000;
const DIAGNOSTICS_MAX = 20_000;

/** A tab's end of the worker: a SharedWorker's MessagePort, or the dedicated worker's own scope. */
interface Port {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** The worker's global as this script uses it (tsconfig types `self` as a Window). */
interface WorkerScope extends Port {
  onconnect?: ((event: { ports: Port[] }) => void) | null;
  navigator: {
    locks?: { request(name: string, callback: () => unknown): Promise<unknown> };
    connection?: { effectiveType?: string };
    onLine?: boolean;
  };
  location: { href: string };
  /** Missing or refusing IndexedDB means an outbox add fails: the composer must keep the draft. */
  indexedDB?: IDBFactory;
}
const scope = self as unknown as WorkerScope;

type Timer = ReturnType<typeof setTimeout>;
type Sample = Record<string, unknown>;

interface Client {
  port: Port;
  streams: Map<number, Subscription>;
  visible: boolean;
}

interface Subscription {
  id: string;
  streamId: number;
  client: Client;
  channel: EventStreamChannel;
  state: ReadyState;
  retryTimer: Timer | undefined;
  /** The EventSource's: every frame's `id:` line is its emit time. */
  listener: (event: MessageEvent<string>) => void;
}

interface LoggedFrame {
  owner: string;
  bytes: number;
  at: number;
  gotAt: number;
}

interface HeldEvent {
  channel: string;
  owner: string;
  at: number;
  gotAt: number;
  bytes: number;
  entry: LoggedFrame | null;
}

interface Reconnect {
  trigger: string;
  dropAt: number;
  startAt: number;
  effectiveTypeBefore: string | null;
  /** The connection said hello again: the next open or stream frame ends the outage. */
  hello: boolean;
}

/** The EventSource's measurement state (spec D6). */
interface Conn {
  key: "sse";
  lastEventSampleAt: number;
  heldEvent: HeldEvent | null;
  reconnect: Reconnect | null;
  /** First unanswered attempt or drop, until hello/welcome or the connection is no longer wanted. */
  connectingSince: number | null;
  largeFrames: LoggedFrame[];
}

interface Clock {
  offset: number;
  rtt: number;
  takenAt: number;
}

interface ControlFrame {
  type?: unknown;
  sub?: unknown;
  connectionId?: unknown;
}

let source: EventSource | null = null;
let connectionId: string | null = null;
let reconnectTimer: Timer | undefined;
let reconnectDelayMs = RECONNECT_MIN_MS;
let nextSubscriptionId = 1;
/** Server subscription id -> subscription. */
const subscriptions = new Map<string, Subscription>();
/** Every attached tab. */
const clients = new Set<Client>();
const sseConn: Conn = { key: "sse", lastEventSampleAt: -Infinity, heldEvent: null, reconnect: null, connectingSince: null, largeFrames: [] };
/** Samples waiting for the next flush, oldest first, and how many overflow dropped since the last one. */
let samples: Sample[] = [];
let droppedSamples = 0;
let flushing = false;
let flushTimer: Timer | undefined;
/** One clock for every connection, event and action: `serverNow = clientNow + offset`, oldest first (see currentClock). */
const clockSamples: Clock[] = [];
/** From the tabs' wakes: this browser's id, and the effective connection type as of the latest one. */
let clientId: string | null = null;
let knownEffectiveType: string | null = null;
/** The latest online, network or visible wake (once per burst from every tab), and the effective type before it. */
let lastWake: { at: number; effectiveType: string | null } | null = null;
/** dropAt of the reconnects that a running one may still count in its `batch`. */
let recentDrops: number[] = [];
/** Every sample of the last DIAGNOSTICS_WINDOW_MS (stamped, as POSTed), with the worker's clock when recorded. */
let diagnosticSamples: { t: number; sample: Sample }[] = [];
let lastReconnect: ConnectionDiagnostics["lastReconnect"] = null;

function post(client: Client, message: unknown): void {
  try {
    client.port.postMessage(message);
  } catch {
    // The tab is gone; its lock/bye cleanup releases the subscriptions.
  }
}

function notifyError(subscription: Subscription, readyState: ReadyState): void {
  subscription.state = readyState;
  post(subscription.client, { id: subscription.streamId, type: "error", readyState });
}

/** A connection dropped: its live subscriptions are reconnecting. */
function markConnecting(list: Iterable<Subscription>): void {
  for (const subscription of list) {
    clearTimeout(subscription.retryTimer);
    if (subscription.state === OPEN) notifyError(subscription, CONNECTING);
  }
}

// ---- SSE ----

function closeSource(): void {
  source?.close();
  source = null;
  connectionId = null;
  // A frame held for the first clock must not be recorded later against another connection.
  sseConn.heldEvent = null;
}

function scheduleReconnect(): void {
  closeSource();
  markConnecting(subscriptions.values());
  dropped(sseConn, "error");
  clearTimeout(reconnectTimer);
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    ensureSource();
  }, delay);
}

function ensureSource(): void {
  if (source || reconnectTimer !== undefined || subscriptions.size === 0) return;
  const current = new EventSource(EVENT_STREAM_PATH);
  source = current;
  sseConn.connectingSince ??= Date.now();
  current.addEventListener(MUX_CONTROL_EVENT, (event: MessageEvent<string>) => {
    if (source !== current) return;
    let frame: ControlFrame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleControl(frame);
  });
  for (const subscription of subscriptions.values()) current.addEventListener(subscription.id, subscription.listener);
  current.onerror = () => {
    if (source !== current) return;
    if (current.readyState === CLOSED) {
      // Fatal (e.g. 401 after the sign-in expired, 5xx): EventSource gives
      // up, so retry with capped backoff rather than going dark for good.
      scheduleReconnect();
      return;
    }
    // CONNECTING: EventSource reconnects on its own; the next hello
    // re-subscribes everything on the fresh connection.
    connectionId = null;
    markConnecting(subscriptions.values());
    dropped(sseConn, "error");
  };
}

function requestServer(body: Record<string, unknown>): Promise<Response> {
  return fetch(EVENT_STREAM_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, ...body }),
    keepalive: true,
  });
}

/** A control frame: a hello, or a subscription's open/end. */
function handleControl(frame: ControlFrame): void {
  if (frame.type === "hello") {
    reconnectDelayMs = RECONNECT_MIN_MS;
    if (typeof frame.connectionId !== "string") return;
    connectionId = frame.connectionId;
    sseConn.connectingSince = null;
    if (sseConn.reconnect) {
      sseConn.reconnect.hello = true;
      // No stream, no frame to end its outage (and nothing was being delivered).
      if (subscriptions.size === 0) sseConn.reconnect = null;
    }
    for (const subscription of subscriptions.values()) subscribe(subscription);
    // The probe after the subscribe POSTs: on HTTP/1.1 it would otherwise hold one of the 6 connections first paint needs.
    void probeSseClock(connectionId);
    return;
  }
  if (frame.type === "open") endReconnect(sseConn, Date.now());
  const subscription = typeof frame.sub === "string" ? subscriptions.get(frame.sub) : undefined;
  if (!subscription) return;
  if (frame.type === "open") {
    subscription.state = OPEN;
    post(subscription.client, { id: subscription.streamId, type: "open" });
  } else if (frame.type === "end") {
    // A server-ended channel keeps EventSource's reconnect semantics.
    retrySubscription(subscription);
  }
}

function subscribe(subscription: Subscription): void {
  if (subscriptions.get(subscription.id) !== subscription || !connectionId) return;
  const requestedOn = connectionId;
  const stale = () => subscriptions.get(subscription.id) !== subscription || connectionId !== requestedOn;
  requestServer({ subscribe: { id: subscription.id, channel: subscription.channel } }).then(async (response) => {
    // Success is signalled by the `open` control frame, which is ordered with
    // the subscription's data on the stream; the POST response is not.
    if (response.ok || stale()) return;
    const body = await response.json().catch(() => null);
    if (stale()) return;
    if (body?.code === UNKNOWN_CONNECTION_CODE) {
      // The server restarted between hello and this POST.
      scheduleReconnect();
      return;
    }
    if (transientFileRefusal(subscription, response.status, body?.code)) return retrySubscription(subscription);
    // Other refusals are terminal; the tab decides whether to reopen them.
    release(subscription);
    notifyError(subscription, CLOSED);
  }, () => {
    if (!stale()) scheduleReconnect();
  });
}

function transientFileRefusal(subscription: Subscription, status: unknown, code: unknown): boolean {
  return subscription.channel.kind === "file"
    && ((status === 503 && code === "host_offline") || (status === 504 && code === "host_timeout"));
}

function retrySubscription(subscription: Subscription): void {
  notifyError(subscription, CONNECTING);
  clearTimeout(subscription.retryTimer);
  subscription.retryTimer = setTimeout(() => subscribe(subscription), RESUBSCRIBE_DELAY_MS);
}

function release(subscription: Subscription): void {
  clearTimeout(subscription.retryTimer);
  subscriptions.delete(subscription.id);
  subscription.client.streams.delete(subscription.streamId);
  source?.removeEventListener(subscription.id, subscription.listener);
  if (subscriptions.size === 0) {
    // Nothing left to deliver: free the browser's connection until a tab asks again.
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    closeSource();
    sseConn.reconnect = null;
    sseConn.connectingSince = null;
  }
}

function open(client: Client, streamId: number, channel: EventStreamChannel): void {
  close(client, streamId);
  const subscription: Subscription = {
    id: `s${nextSubscriptionId++}`,
    streamId,
    client,
    channel,
    state: CONNECTING,
    retryTimer: undefined,
    listener: (event) => deliver(subscription, sseConn, event.data, event.lastEventId ? Number(event.lastEventId) : NaN),
  };
  subscriptions.set(subscription.id, subscription);
  client.streams.set(streamId, subscription);
  // Listen before subscribing: frames may arrive before the POST resolves.
  source?.addEventListener(subscription.id, subscription.listener);
  ensureSource();
  subscribe(subscription);
}

function close(client: Client, streamId: number): void {
  const subscription = client.streams.get(streamId);
  if (!subscription) return;
  const wasConnected = connectionId;
  release(subscription);
  if (wasConnected && connectionId === wasConnected) requestServer({ unsubscribe: subscription.id }).catch(() => {});
}

function dropClient(client: Client): void {
  clients.delete(client);
  for (const streamId of [...client.streams.keys()]) close(client, streamId);
}

/**
 * A tab saw the network change or the page come back (EventSource reconnects on its own). Every wake but `hidden` and
 * `init` may start a reconnect sample's outage (spec D6 `startAt`).
 */
function wake(reason: string): void {
  if (reason === "online" || reason === "network" || reason === "visible") {
    retryAborts();
    retryOutbox();
  }
  const now = Date.now();
  const type = effectiveType();
  // Every tab forwards the same event: the first of a burst keeps the type from before it.
  if (reason !== "hidden" && reason !== "init" && !(lastWake && now - lastWake.at < WAKE_BURST_MS)) {
    lastWake = { at: now, effectiveType: knownEffectiveType ?? type };
  }
  knownEffectiveType = type;
}

// ---- Upload cancels (docs/specs/2026-11-02-file-uploads-design.md U4 "Durable cancel") ----

/** An abort not yet delivered: its DELETE, repeated until the server answers. */
interface Abort {
  host: string | undefined;
  fetching: boolean;
}

/** By upload id: kept until the server has it, so a request that fails never leaves the host's copy staged. */
const aborts = new Map<string, Abort>();
let abortFailures = 0;
let abortTimer: Timer | undefined;

/** The tab removed it: the server deletes what the host staged. */
function abortUpload(id: string, host?: string): void {
  if (aborts.has(id)) return;
  if (aborts.size >= ABORTS_MAX) aborts.delete(aborts.keys().next().value as string);
  const abort: Abort = { host, fetching: false };
  aborts.set(id, abort);
  deleteUpload(id, abort);
}

/** A 2xx or 4xx answer settles it (the server owns delivery from there), except 408 and 429; a network error, a timeout or a 5xx keeps it for a retry. */
function deleteUpload(id: string, abort: Abort): void {
  if (abort.fetching) return;
  abort.fetching = true;
  const query = abort.host === undefined ? "" : `?host=${encodeURIComponent(abort.host)}`;
  // The deadline is above the server's 30 s host-op timeout: a request that hangs (half-open socket) would otherwise
  // keep `fetching` set and block every retry. A timeout counts as not settled.
  withDeadline(ABORT_DELETE_TIMEOUT_MS, (signal) => fetch(`/api/uploads/${encodeURIComponent(id)}${query}`, { method: "DELETE", signal })).then((response) => response.status < 500 && response.status !== 408 && response.status !== 429, () => false).then((settled) => {
    abort.fetching = false;
    if (aborts.get(id) !== abort) return;
    if (settled) {
      aborts.delete(id);
      abortFailures = 0;
    } else if (abortTimer === undefined) {
      abortTimer = setTimeout(retryAborts, ABORT_RETRY_MS[Math.min(abortFailures++, ABORT_RETRY_MS.length - 1)]);
    }
  });
}

function retryAborts(): void {
  clearTimeout(abortTimer);
  abortTimer = undefined;
  for (const [id, abort] of aborts) deleteUpload(id, abort);
}

// ---- Measurement (spec D6 of the experiment) ----

/**
 * A clock sample (NTP-style) from a ping sent at `c` and answered at the server's `at`. A negative RTT (the device clock
 * stepped back mid-ping) is none. The worker's first clock records the frames held for it.
 */
function clockSample(c: number, at: number, now: number): void {
  const rtt = now - c;
  if (!Number.isFinite(rtt) || !Number.isFinite(at) || rtt < 0) return;
  const first = clockSamples.length === 0;
  clockSamples.push({ offset: at - (c + now) / 2, rtt, takenAt: now });
  if (clockSamples.length > CLOCK_WINDOW_SAMPLES) clockSamples.shift();
  if (first) recordHeldEvents();
}

/** The lowest-RTT sample of the window, or null before the first. */
function currentClock(now: number): Clock | null {
  while (clockSamples.length > 1 && now - clockSamples[0].takenAt > CLOCK_WINDOW_MS) clockSamples.shift();
  let best: Clock | null = null;
  for (const sample of clockSamples) if (!best || sample.rtt < best.rtt) best = sample;
  return best;
}

/** After an SSE hello: SSE_CLOCK_PROBES reads of the server clock one after another, then one per SSE_CLOCK_PROBE_MS, while that connection lasts. */
async function probeSseClock(current: string): Promise<void> {
  for (let i = 0; i < SSE_CLOCK_PROBES; i++) {
    if (connectionId !== current) return;
    await probeClock();
  }
  scheduleSseProbe(current);
}

function scheduleSseProbe(current: string): void {
  setTimeout(async () => {
    if (connectionId !== current) return;
    await probeClock();
    scheduleSseProbe(current);
  }, SSE_CLOCK_PROBE_MS);
}

/** Runs `run` with a signal that aborts after `ms` (no AbortSignal.timeout: older browsers lack it). */
async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function probeClock(): Promise<void> {
  const c = Date.now();
  try {
    const body = await withDeadline(METRICS_TIMEOUT_MS, async (signal) => (await fetch(METRICS_PATH, { cache: "no-store", signal })).json());
    clockSample(c, body.now, Date.now());
  } catch {
    // Offline, refused or no answer in time: the next probe tries again.
  }
}

/** Prunes the connection's log of large frames (cross-session blocking) and logs this one if it is large. */
function logFrame(conn: Conn, owner: string, bytes: number, at: number, gotAt: number): LoggedFrame | null {
  const log = conn.largeFrames;
  while (log.length > 0 && gotAt - log[0].gotAt > LARGE_FRAME_LOG_MS) log.shift();
  if (bytes < LARGE_FRAME_BYTES || !Number.isFinite(at)) return null;
  const entry = { owner, bytes, at, gotAt };
  log.push(entry);
  return entry;
}

/**
 * The bytes of logged frames that a frame written at `at` and arrived at `gotAt` came in behind, by owner: written
 * before it, arrived before it and still arriving when it was written. `self`: its own entry, if logged.
 */
function behindFrames(log: LoggedFrame[], owner: string, at: number, gotAt: number, clock: Clock, self: LoggedFrame | null) {
  const behind = { same: 0, other: 0 };
  for (const frame of log) {
    if (frame === self || frame.gotAt > gotAt || frame.at > at || frame.gotAt + clock.offset <= at) continue;
    if (frame.owner === owner) behind.same += frame.bytes;
    else behind.other += frame.bytes;
  }
  return behind;
}

/**
 * A stream's frame from its connection, then to the tab: at most one event sample per connection per EVENT_SAMPLE_MS
 * (one behind another session's large frame always). Before the worker's first clock the connection's first frame is
 * held and recorded with that clock (recordHeldEvents).
 */
function deliver(subscription: Subscription, conn: Conn, data: string, at: number): void {
  const { channel } = subscription;
  const gotAt = Date.now();
  const owner = channel.kind === "session" ? channel.sessionId : "app";
  const entry = logFrame(conn, owner, data.length, at, gotAt);
  endReconnect(conn, gotAt);
  if (Number.isFinite(at)) {
    const clock = currentClock(gotAt);
    if (clock) {
      const behind = behindFrames(conn.largeFrames, owner, at, gotAt, clock, entry);
      if (behind.other > 0 || gotAt - conn.lastEventSampleAt >= EVENT_SAMPLE_MS) eventSample(conn, channel.kind, at, gotAt, data.length, clock, behind);
    } else if (conn.lastEventSampleAt === -Infinity) {
      conn.lastEventSampleAt = gotAt;
      conn.heldEvent = { channel: channel.kind, owner, at, gotAt, bytes: data.length, entry };
    }
  }
  post(subscription.client, { id: subscription.streamId, type: "message", data });
}

function eventSample(conn: Conn, channel: string, at: number, gotAt: number, bytes: number, clock: Clock, behind: { same: number; other: number }): void {
  conn.lastEventSampleAt = gotAt;
  record({ metric: "event", socket: conn.key, channel, at, gotAt, offset: clock.offset, offsetRtt: clock.rtt, bytes, behindSameBytes: behind.same, behindOtherBytes: behind.other });
}

/** The worker's first clock: the frames held for it are recorded with it. */
function recordHeldEvents(): void {
  const clock = currentClock(Date.now());
  if (!clock) return;
  const held = sseConn.heldEvent;
  if (!held) return;
  sseConn.heldEvent = null;
  eventSample(sseConn, held.channel, held.at, held.gotAt, held.bytes, clock, behindFrames(sseConn.largeFrames, held.owner, held.at, held.gotAt, clock, held.entry));
}

/** A tab's sample. An HTTP action's reply shared the SSE stream's HTTP/2 connection: measured against its frame log. */
function recordTabSample(sample: Sample): void {
  if (sample.metric === "action" && sample.via === "http" && sample.replyBehindOtherBytes === null && Number.isFinite(sample.repliedAt) && Number.isFinite(sample.gotAt)) {
    const clock = currentClock(Date.now());
    const behind = clock && behindFrames(sseConn.largeFrames, String(sample.session), Number(sample.repliedAt), Number(sample.gotAt), clock, null);
    if (behind) sample = { ...sample, replyBehindOtherBytes: behind.other };
  }
  record(sample);
}

/** A connection dropped (`reconnect`): its outage runs from the first drop until a stream gets a frame after the next hello or welcome. */
function dropped(conn: Conn, trigger: string): void {
  conn.connectingSince ??= Date.now();
  if (conn.reconnect) return;
  const dropAt = Date.now();
  const woke = lastWake !== null && dropAt - lastWake.at <= WAKE_WINDOW_MS;
  conn.reconnect = { trigger, dropAt, startAt: woke && lastWake ? lastWake.at : dropAt, effectiveTypeBefore: woke && lastWake ? lastWake.effectiveType : effectiveType(), hello: false };
  // A drop is kept while an outage within BATCH_WINDOW_MS of it may still end and count it.
  recentDrops = recentDrops.filter((at) => at >= dropAt - BATCH_WINDOW_MS);
  recentDrops.push(dropAt);
}

/** The outage's end: the reconnect sample, `batch` counting the drops within BATCH_WINDOW_MS of this one. */
function endReconnect(conn: Conn, now: number): void {
  const reconnect = conn.reconnect;
  if (!reconnect?.hello) return;
  conn.reconnect = null;
  lastReconnect = { at: now, trigger: reconnect.trigger, outageMs: now - reconnect.dropAt };
  let batch = 0;
  for (const at of recentDrops) if (Math.abs(at - reconnect.dropAt) <= BATCH_WINDOW_MS) batch += 1;
  record({
    metric: "reconnect",
    socket: conn.key,
    trigger: reconnect.trigger,
    dropAt: reconnect.dropAt,
    startAt: reconnect.startAt,
    firstFrameAt: now,
    batch,
    effectiveTypeBefore: reconnect.effectiveTypeBefore,
  });
}

// Samples: tagged here, buffered (METRICS_BUFFER_MAX, the oldest dropped and counted) and POSTed over HTTP.

function effectiveType(): string | null {
  return scope.navigator.connection?.effectiveType ?? null;
}

/** The tags a sample lacks; an action sample (the tab's) also gets the worker's clock. */
function stamp(sample: Sample): Sample {
  const socket = typeof sample.socket === "string" ? sample.socket : "worker";
  let visible = false;
  for (const client of clients) visible = visible || client.visible;
  const clock = sample.metric === "action" ? currentClock(Date.now()) : null;
  return {
    transport: "sse",
    socket,
    conn: socket,
    sockets: source ? 1 : 0,
    clientId,
    effectiveType: effectiveType(),
    visible,
    ...(sample.metric === "action" ? { offset: clock ? clock.offset : null, offsetRtt: clock ? clock.rtt : null } : {}),
    ...sample,
  };
}

function record(sample: Sample): void {
  const stamped = stamp(sample);
  samples.push(stamped);
  diagnosticSamples.push({ t: Date.now(), sample: stamped });
  if (diagnosticSamples.length > DIAGNOSTICS_MAX) diagnosticSamples.splice(0, diagnosticSamples.length - DIAGNOSTICS_MAX);
  trimSamples();
  // Reaching the count flushes right after this task, off the path that recorded it (a frame's delivery); a failed POST
  // leaves more than that, which then waits for the timer instead of retrying per sample.
  if (samples.length === METRICS_FLUSH_COUNT) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushSamples, 0);
  } else {
    scheduleFlush();
  }
}

function trimSamples(): void {
  const over = samples.length - METRICS_BUFFER_MAX;
  if (over <= 0) return;
  samples.splice(0, over);
  droppedSamples += over;
}

function scheduleFlush(): void {
  if (flushTimer === undefined && samples.length > 0) flushTimer = setTimeout(flushSamples, METRICS_FLUSH_MS);
}

/** POSTs the oldest METRICS_FLUSH_COUNT samples (and a `dropped` count); a failure keeps them for the next flush. */
function flushSamples(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (flushing || samples.length === 0) return;
  const batch = samples.splice(0, METRICS_FLUSH_COUNT);
  const droppedCount = droppedSamples;
  droppedSamples = 0;
  flushing = true;
  const body = JSON.stringify({ samples: droppedCount > 0 ? batch.concat(stamp({ metric: "dropped", count: droppedCount })) : batch });
  // The deadline grows with the batch so a slow link (about 2 KB/s and up) can finish it. A timeout after the server has
  // processed the batch sends it again and duplicates its samples (metrics only).
  withDeadline(METRICS_TIMEOUT_MS + body.length / METRICS_POST_BYTES_PER_MS, async (signal) => (await fetch(METRICS_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  })).ok)
    .catch(() => false)
    .then((ok) => {
      flushing = false;
      if (ok && samples.length >= METRICS_FLUSH_COUNT) {
        flushSamples();
        return;
      }
      if (!ok) {
        samples = batch.concat(samples);
        droppedSamples += droppedCount;
        trimSamples();
      }
      scheduleFlush();
    });
}

/** The connection diagnostics panel's snapshot: the connection in use now and the last DIAGNOSTICS_WINDOW_MS of samples. */
function diagnostics(): ConnectionDiagnostics {
  const now = Date.now();
  const from = diagnosticSamples.findIndex((entry) => now - entry.t <= DIAGNOSTICS_WINDOW_MS);
  diagnosticSamples = from === -1 ? [] : diagnosticSamples.slice(from);
  const wanted = subscriptions.size > 0;
  const connected = source !== null && connectionId !== null;
  const since = !wanted || connected ? null : sseConn.connectingSince;
  let reconnects = 0;
  for (const { sample } of diagnosticSamples) if (sample.metric === "reconnect") reconnects++;
  const clock = currentClock(now);
  return {
    status: !wanted ? "idle" : connected ? "connected" : since !== null && now - since >= DOWN_AFTER_MS ? "down" : "connecting",
    since,
    lastReconnect,
    reconnects,
    clockRttMs: clock ? clock.rtt : null,
    effectiveType: effectiveType(),
    windowMs: DIAGNOSTICS_WINDOW_MS,
    stats: diagnosticStats(diagnosticSamples.map((entry) => entry.sample)),
  };
}

// ---- The message outbox's first leg (docs/specs/2026-11-04-message-outbox-design.md O2): a message is committed to
// IndexedDB before the tab's composer clears, then goes as `outbox_add` over the current transport until the server
// has stored it. Each session's entries go one at a time, oldest first: the server queues them in arrival order. ----

const OUTBOX_DB = "tau-outbox";
const OUTBOX_STORE = "entries";
/** The server keeps delivered ids 8 days: an older entry is never sent again, or a resend could deliver it twice. */
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The immutable intent used by server retry validation: mode, text, images and upload IDs. */
function sameOutboxIntent(a: LocalOutboxEntry, b: LocalOutboxEntry): boolean {
  if (a.mode !== b.mode || a.message !== b.message) return false;
  const aImages = a.images;
  const bImages = b.images;
  const imageCount = aImages?.length ?? 0;
  if (imageCount !== (bImages?.length ?? 0)) return false;
  for (let index = 0; index < imageCount; index++) {
    const left = aImages?.[index];
    const right = bImages?.[index];
    if (left?.type !== right?.type || left?.data !== right?.data || left?.mimeType !== right?.mimeType) return false;
  }
  const aUploads = a.uploads;
  const bUploads = b.uploads;
  const uploadCount = aUploads?.length ?? 0;
  if (uploadCount !== (bUploads?.length ?? 0)) return false;
  for (let index = 0; index < uploadCount; index++) if (aUploads?.[index] !== bUploads?.[index]) return false;
  return true;
}

/** One host's copy of a session: the same id on another host is another session (a row from before hosts is this machine's). */
const outboxSession = (entry: Pick<LocalOutboxEntry, "sessionId" | "hostId">): string => `${entry.hostId ?? "local"}/${entry.sessionId}`;

// A local failed ancestor proves lineage only in the same session (host copy) with the exact original intent.
function replacementRoot(entry: LocalOutboxEntry, entries: ReadonlyMap<string, LocalOutboxEntry>): string | null {
  if (entry.replaces === undefined) return entry.id;
  const seen = new Set([entry.id]);
  let id = entry.replaces;
  if (!id) return null;
  while (true) {
    if (seen.has(id)) return null;
    seen.add(id);
    const parent = entries.get(id);
    if (!parent || outboxSession(parent) !== outboxSession(entry) || parent.state !== "failed") return id;
    if (!sameOutboxIntent(parent, entry)) return null;
    if (parent.replaces === undefined) return id;
    id = parent.replaces;
    if (!id) return null;
  }
}
function replacementDescendsFrom(entry: LocalOutboxEntry, ancestorId: string, entries: ReadonlyMap<string, LocalOutboxEntry>): boolean {
  const seen = new Set([entry.id]);
  let id = entry.replaces;
  while (id) {
    if (id === ancestorId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const parent = entries.get(id);
    if (!parent || outboxSession(parent) !== outboxSession(entry) || parent.state !== "failed"
      || !sameOutboxIntent(parent, entry) || parent.replaces === undefined) return false;
    id = parent.replaces;
  }
  return false;
}


interface OutboxItem {
  entry: LocalOutboxEntry;
  /** An attempt is out: its answer decides what comes next. */
  inFlight: boolean;
  retryTimer: Timer | undefined;
  /** The next transient failure's delay: RECONNECT_MIN_MS doubling to RECONNECT_MAX_MS, reset by a wake. */
  retryMs: number;
}

/** Every entry this browser holds, by id. */
const outboxItems = new Map<string, OutboxItem>();
/** One shared-store head read per session (host copy, `outboxSession`) at a time, including while several local entries commit. */
const outboxReading = new Set<string>();
const outboxDropping = new Set<string>();
/** A session whose shared-list read failed reads again after this delay (1 s doubling to 30 s): no send goes before it. */
const outboxReadRetry = new Map<string, { timer: Timer | undefined; ms: number }>();
/** The last read of the shared list failed: this worker's list may miss other workers' earlier entries. */
let outboxPartial = false;
const outboxDb = openOutboxDb();
/** The stored entries are loaded (and sent): every tab's outbox op waits for it, so none races them. */
let outboxReady = outboxDb.then(loadOutbox);

/** Retry a failed load on the next operation; concurrent tabs share that attempt too. */
async function ensureOutboxReady(): Promise<boolean> {
  const pending = outboxReady;
  if (await pending) return true;
  if (outboxReady === pending) outboxReady = outboxDb.then(loadOutbox);
  return outboxReady;
}

/** null where IndexedDB is missing or refuses: adds must fail without a durable store. */
function openOutboxDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const factory = scope.indexedDB;
    if (!factory) return resolve(null);
    try {
      const request = factory.open(OUTBOX_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** A failed read must not let a private worker's incomplete snapshot choose which message goes first. */
function readOutbox(db: IDBDatabase | null): Promise<LocalOutboxEntry[] | null> {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const transaction = db.transaction(OUTBOX_STORE);
      const request = transaction.objectStore(OUTBOX_STORE).getAll();
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
/** Normalize legacy retry chains atomically before any sending row can reach the server. */
function readOutboxForSend(db: IDBDatabase | null): Promise<LocalOutboxEntry[] | null> {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    let entries: LocalOutboxEntry[] | null = null;
    try {
      const transaction = db.transaction(OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(OUTBOX_STORE);
      const request = store.getAll();
      transaction.oncomplete = () => resolve(entries);
      transaction.onerror = transaction.onabort = request.onerror = () => resolve(null);
      request.onsuccess = () => {
        entries = request.result as LocalOutboxEntry[];
        const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (entry.state !== "sending" || entry.replaces === undefined) continue;
          const root = replacementRoot(entry, byId);
          if (root === null || root === entry.replaces) continue;
          const normalized = { ...entry, replaces: root };
          entries[index] = normalized;
          byId.set(entry.id, normalized);
          store.put(normalized);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

/** What an earlier worker (or tab) left: every unsent entry goes again. */
async function loadOutbox(db: IDBDatabase | null): Promise<boolean> {
  const stored = await readOutbox(db);
  if (!stored) return false;
  for (const entry of stored) outboxItems.set(entry.id, { entry, inFlight: false, retryTimer: undefined, retryMs: RECONNECT_MIN_MS });
  await Promise.all([...new Set(stored.map(outboxSession))].map((session) => sendOutbox(session)));
  return true;
}

/** True only once a write commits: a quota error or abort must not clear the composer's draft. */
async function writeOutbox(change: (store: IDBObjectStore) => void): Promise<boolean> {
  const db = await outboxDb;
  if (!db) return false;
  return await new Promise<boolean>((resolve) => {
    try {
      const transaction = db.transaction(OUTBOX_STORE, "readwrite");
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = transaction.onabort = () => resolve(false);
      change(transaction.objectStore(OUTBOX_STORE));
    } catch {
      resolve(false);
    }
  });
}

/** Unsequenced legacy rows precede new adds; their already-lost timestamp ties use a deterministic id fallback. */
function compareOutbox(a: LocalOutboxEntry, b: LocalOutboxEntry): number {
  return (a.enqueueOrder ?? 0) - (b.enqueueOrder ?? 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Every entry, in submission order. */
function outboxList(): LocalOutboxEntry[] {
  return [...outboxItems.values()].map((item) => item.entry).sort(compareOutbox);
}

function broadcastOutbox(): void {
  const list = outboxList();
  for (const client of clients) post(client, outboxPartial ? { outbox: list, partial: true } : { outbox: list });
}

/** A tab's list once loaded. An empty one only when `always`: a tab back from the bfcache may still show gone entries. */
function tellOutbox(client: Client, always: boolean): void {
  void ensureOutboxReady().then((loaded) => {
    if (loaded && (always || outboxItems.size > 0)) post(client, outboxPartial ? { outbox: outboxList(), partial: true } : { outbox: outboxList() });
  });
}

function addOutbox(client: Client, n: number, entry: LocalOutboxEntry): void {
  void ensureOutboxReady().then(async (loaded) => {
    const item: OutboxItem = { entry: { ...entry, state: "sending" }, inFlight: false, retryTimer: undefined, retryMs: RECONNECT_MIN_MS };
    let invalidRetry = false;
    let reused: LocalOutboxEntry | undefined;
    const committed = loaded && await writeOutbox((store) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result as LocalOutboxEntry[];
        const byId = new Map(entries.map((saved) => [saved.id, saved] as const));
        const root = replacementRoot(entry, byId);
        if (root === null) {
          invalidRetry = true;
          return;
        }
        const normalized = entry.replaces === undefined ? entry : { ...entry, replaces: root };
        if (entry.replaces !== undefined) {
          let pending: LocalOutboxEntry | undefined;
          for (const saved of entries) {
            if (outboxSession(saved) !== outboxSession(entry) || saved.state !== "sending" || saved.replaces === undefined
              || replacementRoot(saved, byId) !== root) continue;
            if (!pending || compareOutbox(saved, pending) < 0) pending = saved;
          }
          if (pending) {
            if (sameOutboxIntent(pending, normalized)) reused = pending;
            else invalidRetry = true;
            return;
          }
          const localRoot = byId.get(root);
          if (localRoot && outboxSession(localRoot) === outboxSession(entry)
            && (localRoot.state !== "failed" || !sameOutboxIntent(localRoot, normalized))) {
            invalidRetry = true;
            return;
          }
        }
        item.entry = {
          ...normalized,
          state: "sending",
          enqueueOrder: entries.reduce((max, row) => Math.max(max, row.enqueueOrder ?? 0), 0) + 1,
        };
        store.add(item.entry);
      };
    });
    if (!committed || invalidRetry) {
      post(client, {
        outboxAdded: n,
        error: invalidRetry ? "This retry chain is invalid. Retry the original message instead." : "The message could not be saved to this browser. Send it again.",
      });
      return;
    }
    if (reused) {
      if (!outboxItems.has(reused.id)) outboxItems.set(reused.id, { entry: reused, inFlight: false, retryTimer: undefined, retryMs: RECONNECT_MIN_MS });
      await refreshOutbox();
      broadcastOutbox();
      post(client, { outboxAdded: n });
      // A peer may commit and exit before sending; replaying the existing ID remains idempotent.
      sendOutbox(outboxSession(reused));
      return;
    }
    // Committed: the entry is accepted whatever follows, or a resend from the composer would duplicate it under a new id.
    outboxItems.set(item.entry.id, item);
    // Include earlier entries from every worker before the tab can clear its composer or run pagehide keepalives; a failed
    // read only delays the send (sendOutbox reads again before any network attempt).
    await refreshOutbox();
    broadcastOutbox();
    post(client, { outboxAdded: n });
    sendOutbox(outboxSession(item.entry));
  });
}

function dropOutbox(client: Client, n: number, id: string): void {
  void ensureOutboxReady().then(async (loaded) => {
    const item = outboxItems.get(id);
    outboxDropping.add(id);
    const removed = loaded && await writeOutbox((store) => store.delete(id));
    outboxDropping.delete(id);
    if (!removed) {
      post(client, { outboxDropped: n, error: "The message could not be removed from this browser. Try again." });
      return;
    }
    clearTimeout(item?.retryTimer);
    outboxItems.delete(id);
    post(client, { outboxDropped: n });
    broadcastOutbox();
    if (item) sendOutbox(outboxSession(item.entry));
  });
}
/** Server identity snapshots can prove a browser's local copy was accepted even when its POST reply was lost. */
function reconcileOutbox(client: Client, n: number, sessionId: string, hostId: string, value: unknown): void {
  const session = outboxSession({ sessionId, hostId });
  void ensureOutboxReady().then(async (loaded) => {
    if (!loaded || !Array.isArray(value) || !value.every((id) => typeof id === "string")) {
      post(client, { outboxReconciled: n, error: "The browser outbox could not be reconciled. Retry again." });
      return;
    }
    const confirmed = new Set(value as string[]);
    const removedIds = new Set<string>();
    const committed = await writeOutbox((store) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result as LocalOutboxEntry[];
        const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
        for (const entry of entries) {
          if (outboxSession(entry) !== session || !confirmed.has(entry.id)) continue;
          removedIds.add(entry.id);
          store.delete(entry.id);
          if (entry.replaces === undefined) continue;
          const root = replacementRoot(entry, byId);
          if (root === null) continue;
          const original = byId.get(root);
          if (!original || outboxSession(original) !== session || original.state !== "failed" || !sameOutboxIntent(original, entry)) continue;
          for (const candidate of entries) {
            if (candidate.id === entry.id || outboxSession(candidate) !== session || candidate.state !== "failed"
              || !sameOutboxIntent(candidate, entry) || replacementDescendsFrom(candidate, entry.id, byId)) continue;
            if (candidate.id !== root && replacementRoot(candidate, byId) !== root) continue;
            removedIds.add(candidate.id);
            store.delete(candidate.id);
          }
        }
      };
    });
    if (!committed) {
      post(client, { outboxReconciled: n, error: "The browser outbox could not be reconciled. Retry again." });
      return;
    }
    for (const id of removedIds) {
      clearTimeout(outboxItems.get(id)?.retryTimer);
      outboxItems.delete(id);
    }
    await refreshOutbox();
    broadcastOutbox();
    post(client, { outboxReconciled: n });
    if (removedIds.size > 0) sendOutbox(session);
  });
}

/** Refresh the whole shared list before exposing an add or choosing a session head; null means the read failed. */
async function refreshOutbox(): Promise<boolean | null> {
  const entries = await readOutboxForSend(await outboxDb);
  if (!entries) {
    outboxPartial = true;
    return null;
  }
  const ids = new Set(entries.map((entry) => entry.id));
  // Back to a complete view: the tabs hear it even when no entry changed.
  let changed = outboxPartial;
  outboxPartial = false;
  for (const [id, item] of outboxItems) {
    if (ids.has(id)) continue;
    clearTimeout(item.retryTimer);
    outboxItems.delete(id);
    changed = true;
  }
  for (const entry of entries) {
    const item = outboxItems.get(entry.id);
    if (!item) {
      outboxItems.set(entry.id, { entry, inFlight: false, retryTimer: undefined, retryMs: RECONNECT_MIN_MS });
      changed = true;
    } else if (item.entry.state !== entry.state || item.entry.error !== entry.error || item.entry.replaces !== entry.replaces) {
      item.entry = entry;
      changed = true;
    }
  }
  return changed;
}

/** Every attempt reads the shared store: dedicated workers and old/new SharedWorkers must agree on the session head.
 * `session`: one host's copy (`outboxSession`). */
async function sendOutbox(session: string): Promise<void> {
  if (outboxReading.has(session)) return;
  outboxReading.add(session);
  const changed = await refreshOutbox();
  outboxReading.delete(session);
  if (changed === null) {
    const retry = outboxReadRetry.get(session) ?? { timer: undefined, ms: RECONNECT_MIN_MS };
    outboxReadRetry.set(session, retry);
    if (retry.timer !== undefined) return;
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      sendOutbox(session);
    }, retry.ms);
    retry.ms = Math.min(retry.ms * 2, RECONNECT_MAX_MS);
    return;
  }
  clearTimeout(outboxReadRetry.get(session)?.timer);
  outboxReadRetry.delete(session);
  if (changed) broadcastOutbox();
  const entries = outboxList();
  const head = entries.find((entry) => outboxSession(entry) === session && entry.state === "sending");
  const item = head && outboxItems.get(head.id);
  if (!item || item.inFlight || item.retryTimer !== undefined || outboxDropping.has(item.entry.id)) return;
  if (item?.entry.replaces !== undefined && replacementRoot(item.entry, new Map(entries.map((entry) => [entry.id, entry] as const))) === null) {
    return failOutbox(item, "This retry chain is invalid; remove this message and retry its original.");
  }
  if (Date.now() - item.entry.createdAt > OUTBOX_MAX_AGE_MS) return failOutbox(item, "Not sent within 7 days.");
  if (typeof item.entry.scope !== "string" || !item.entry.scope) return failOutbox(item, "This message has no saved installation or sign-in scope and cannot be sent.");
  item.inFlight = true;
  const { id, sessionId, hostId, scope, mode, message, images, uploads, uploadProofs, replaces } = item.entry;
  const body = JSON.stringify({ type: "outbox_add", id, scope, mode, message, images, uploads, uploadProofs, replaces });
  // A half-open POST must not block this session forever; include the body read and allow 2 KB/s for its uplink.
  withDeadline(40_000 + Math.ceil(body.length / 2), async (signal) => {
    const url = `/api/agent/${encodeURIComponent(sessionId)}${hostId ? `?hostId=${encodeURIComponent(hostId)}` : ""}`;
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal });
    const reply = await response.json().catch((error) => {
      if (signal.aborted) throw error;
      return null;
    });
    return { status: response.status, body: reply };
  }).then(
    ({ status, body }) => outboxAnswer(item, status, body),
    () => outboxAnswer(item, 0, null),
  );
}

/** A transport success is not a storage receipt (a sign-in page can also answer 200). */
function acceptedOutboxEntry(body: unknown, id: string): unknown {
  const reply = body as { success?: unknown; data?: { entry?: Record<string, unknown> } } | null;
  const entry = reply?.data?.entry;
  return reply?.success === true && entry?.id === id &&
    typeof entry.sessionId === "string" && entry.sessionId.length > 0 &&
    ["prompt", "followUp", "steer"].includes(entry.mode as string) &&
    ["held", "waiting_host", "delivering", "failed", "delivered"].includes(entry.state as string) &&
    (entry.images === undefined || Array.isArray(entry.images) && entry.images.every((image) => image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string")) &&
    (entry.uploads === undefined || Array.isArray(entry.uploads) && entry.uploads.every((upload) => typeof upload === "string")) &&
    (entry.error === undefined || typeof entry.error === "string") &&
    (entry.mayHaveBeenSent === undefined || typeof entry.mayHaveBeenSent === "boolean") &&
    (entry.settlement === undefined || ["native", "none", "uncorrelated"].includes(entry.settlement as string)) &&
    (entry.replaces === undefined || typeof entry.replaces === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(entry.replaces)) &&
    typeof entry.message === "string" && typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) && entry.createdAt >= 0
    ? entry : null;
}

/**
 * Valid 2xx acceptance: stored, gone from here. Unconfirmed success, no answer, 401, 408, 429 or a 5xx: again after the entry's
 * delay. Any other refusal is final (O6): "failed" until a tab drops it, and the session's next entry goes.
 */
async function outboxAnswer(item: OutboxItem, status: number, body: unknown): Promise<void> {
  const { id, replaces } = item.entry;
  const session = outboxSession(item.entry);
  if (outboxItems.get(id) !== item) return;
  const reply = (body ?? {}) as { error?: unknown };
  const accepted = acceptedOutboxEntry(body, id);
  if (status >= 200 && status < 300 && !accepted) status = 0;
  if (status >= 200 && status < 300) {
    // Commit the accepted ID and only server-confirmed or locally proven retry lineage together.
    const confirmedReplaces = isRecord(accepted) && typeof accepted.replaces === "string" && accepted.replaces === replaces
      ? accepted.replaces : undefined;
    const removedIds = new Set([id]);
    let localReplaces: string | undefined;
    if (!(await writeOutbox((store) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result as LocalOutboxEntry[];
        const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
        let lineageRoot = confirmedReplaces;
        if (lineageRoot === undefined && replaces !== undefined) {
          const localRoot = replacementRoot(item.entry, byId);
          const original = localRoot === null ? undefined : byId.get(localRoot);
          if (localRoot !== null && original && outboxSession(original) === session && original.state === "failed" && sameOutboxIntent(original, item.entry)) {
            lineageRoot = localRoot;
            localReplaces = localRoot;
          }
        } else localReplaces = confirmedReplaces;
        for (const entry of entries) {
          if (outboxSession(entry) !== session) continue;
          if (entry.id === id) {
            removedIds.add(entry.id);
            store.delete(entry.id);
            continue;
          }
          if (lineageRoot === undefined || !sameOutboxIntent(entry, item.entry)
            || entry.id !== lineageRoot && replacementRoot(entry, byId) !== lineageRoot) continue;
          removedIds.add(entry.id);
          store.delete(entry.id);
        }
      };
    }))) return outboxAnswer(item, 0, null);
    for (const removedId of removedIds) {
      clearTimeout(outboxItems.get(removedId)?.retryTimer);
      outboxItems.delete(removedId);
    }
    const stored = isRecord(accepted) && accepted.state === "delivered"
      && (accepted.settlement === "native" || accepted.settlement === "uncorrelated")
      ? {
          ...accepted,
          message: item.entry.message,
          ...(item.entry.images ? { images: item.entry.images } : {}),
          ...(item.entry.uploads ? { uploads: item.entry.uploads } : {}),
        }
      : accepted;
    const representedRoot = confirmedReplaces ?? localReplaces;
    for (const client of clients) post(client, {
      outboxStored: representedRoot && isRecord(stored) ? { ...stored, replaces: representedRoot } : stored,
    });
  } else if (status === 0 || status === 401 || status === 408 || status === 429 || status >= 500) {
    item.inFlight = false;
    item.retryTimer = setTimeout(() => {
      item.retryTimer = undefined;
      sendOutbox(session);
    }, item.retryMs);
    item.retryMs = Math.min(item.retryMs * 2, RECONNECT_MAX_MS);
    return;
  } else {
    return failOutbox(item, typeof reply.error === "string" ? reply.error : `HTTP ${status}`);
  }
  broadcastOutbox();
  sendOutbox(session);
}

/** Final: "failed" until a tab drops it, and the session's next entry goes. Written only over a row still "sending" in
 * the same transaction: another worker (or the service worker) may have had a 200 and deleted it meanwhile. */
async function failOutbox(item: OutboxItem, error: string): Promise<void> {
  item.inFlight = true;
  const { id } = item.entry;
  const failed: LocalOutboxEntry = { ...item.entry, state: "failed", error };
  const read: { stored?: LocalOutboxEntry } = {};
  const committed = await writeOutbox((store) => {
    const request = store.get(id);
    request.onsuccess = () => {
      read.stored = request.result as LocalOutboxEntry | undefined;
      if (read.stored?.state === "sending") store.put(failed);
    };
  });
  if (!committed) return outboxAnswer(item, 0, null);
  item.inFlight = false;
  if (outboxItems.get(id) !== item) return;
  if (!read.stored) {
    clearTimeout(item.retryTimer);
    outboxItems.delete(id);
  } else item.entry = read.stored.state === "sending" ? failed : read.stored;
  broadcastOutbox();
  sendOutbox(outboxSession(item.entry));
}

/** The network or the page is back: every waiting entry goes again now, from the shortest delay. */
function retryOutbox(): void {
  for (const item of outboxItems.values()) {
    clearTimeout(item.retryTimer);
    item.retryTimer = undefined;
    item.retryMs = RECONNECT_MIN_MS;
  }
  for (const item of [...outboxItems.values()]) sendOutbox(outboxSession(item.entry));
}

function attach(port: Port): void {
  const client: Client = { port, streams: new Map(), visible: false };
  clients.add(client);
  tellOutbox(client, false);
  port.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    const data = message as Record<string, unknown>;
    // A tab back from the bfcache sends whatever comes first (a `wake`, often, or the reopened streams) after its `bye`
    // removed it: it missed any outbox change since.
    if (data.op !== "bye" && !clients.has(client)) {
      clients.add(client);
      tellOutbox(client, true);
    }
    switch (data.op) {
      case "open":
        open(client, Number(data.id), data.channel as EventStreamChannel);
        break;
      case "close":
        close(client, Number(data.id));
        break;
      case "bye":
        dropClient(client);
        break;
      case "wake":
        client.visible = data.visible === true;
        if (typeof data.clientId === "string") clientId = data.clientId;
        wake(String(data.reason));
        break;
      case "diag":
        post(client, { diag: data.n, data: diagnostics() });
        break;
      case "metric":
        if (data.sample && typeof data.sample === "object") recordTabSample(data.sample as Sample);
        break;
      case "upload":
        // A Retry under this id supersedes a cancel still pending for it: it must not delete the new upload.
        aborts.delete(String(data.id));
        break;
      case "up_abort":
        abortUpload(String(data.id), typeof data.host === "string" ? data.host : undefined);
        break;
      case "outbox_add":
        addOutbox(client, Number(data.n), data.entry as LocalOutboxEntry);
        break;
      case "outbox_drop":
        dropOutbox(client, Number(data.n), String(data.id));
        break;
      case "outbox_reconcile":
        reconcileOutbox(client, Number(data.n), typeof data.sessionId === "string" ? data.sessionId : "", typeof data.hostId === "string" ? data.hostId : "local", data.confirmedIds);
        break;
      case "lock":
        // MessagePort has no close event. The tab holds this lock for its
        // whole life; it is granted to us only once that tab is gone
        // (closed, crashed, discarded), however it died.
        void scope.navigator.locks?.request(String(data.name), () => {
          dropClient(client);
        });
        break;
    }
  };
}

if ("onconnect" in scope) scope.onconnect = (event) => attach(event.ports[0]);
else attach(scope);
