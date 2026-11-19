import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildEventStreamWorker } from "../server/client-env.ts";
import { fakeIndexedDB } from "../tests/fake-indexeddb.mjs";

// Runs the real lib/event-stream-worker.ts, bundled (unminified, so its top-level `samples` stays readable) the way
// server/client-env.ts bundles it, in a VM with fake browser globals: EventSource, fetch, Web Locks and tab
// MessagePorts. Time (Date.now, setTimeout, setInterval) is the host's, so t.mock.timers drives it.
// `/api/transport-metrics` answers the SSE clock probe as a server `serverOffset` ms ahead and records every sample batch
// POSTed to it (`metricsStatus` its HTTP status).
// `indexedDB` (fakeIndexedDB) is the worker's; without it outbox adds must fail.
const built = await Bun.build({ entrypoints: [fileURLToPath(new URL("./event-stream-worker.ts", import.meta.url))], target: "browser", format: "esm" });
assert.ok(built.success, built.logs.join("\n"));
const workerSource = await built.outputs[0].text();

const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadWorker({ respond = () => ({ status: 200, body: { ok: true } }), serverOffset = 0, metricsStatus = () => 200, metricsHang = () => false, deleteStatus = () => 204, deleteHang = () => false, indexedDB } = {}) {
  const sources = [];
  const posts = [];
  const probes = [];
  const requests = [];
  const flushes = [];
  const locks = new Map();

  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.CONNECTING;
      this.listeners = new Map();
      this.closed = false;
      this.onerror = null;
      sources.push(this);
    }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(fn);
    }
    removeEventListener(name, fn) {
      this.listeners.get(name)?.delete(fn);
    }
    close() {
      this.closed = true;
      this.readyState = FakeEventSource.CLOSED;
    }
    dispatch(name, data, lastEventId = "") {
      for (const fn of this.listeners.get(name) ?? []) fn({ data: typeof data === "string" ? data : JSON.stringify(data), lastEventId });
    }
    hello(connectionId) {
      this.readyState = FakeEventSource.OPEN;
      this.dispatch("mux", { type: "hello", connectionId });
    }
    drop(readyState) {
      this.readyState = readyState;
      this.onerror?.();
    }
  }

  class SharedWorkerGlobalScope {}
  const self = Object.create(SharedWorkerGlobalScope.prototype);
  self.onconnect = null;
  self.navigator = {
    locks: {
      request(name, callback) {
        locks.set(name, callback);
        return Promise.resolve();
      },
    },
  };
  self.location = { href: "https://example.test/" };
  if (indexedDB) self.indexedDB = indexedDB;

  const context = vm.createContext({
    self,
    EventSource: FakeEventSource,
    URL,
    TextEncoder,
    TextDecoder,
    Blob,
    Date: { now: () => Date.now() },
    AbortController,
    JSON,
    Map,
    Set,
    Math,
    Promise,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (id) => clearInterval(id),
    fetch: async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/transport-metrics") {
        if (init?.method !== "POST") probes.push(Date.now());
        else flushes.push(JSON.parse(init.body).samples);
        // A request that never answers, ended only by the worker's abort.
        if (metricsHang()) await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ now: Date.now() + serverOffset }) };
        const status = metricsStatus();
        return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
      }
      if (init?.method === "DELETE") {
        // A request that never answers, ended only by the worker's abort.
        if (deleteHang()) await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        const status = deleteStatus();
        if (status === 0) throw new TypeError("Failed to fetch");
        return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
      }
      const body = JSON.parse(init.body);
      posts.push(body);
      const { status, body: responseBody } = await respond(body, init, url);
      return { ok: status >= 200 && status < 300, status, json: async () => responseBody };
    },
  });
  vm.runInContext(workerSource, context);

  function connectTab() {
    const received = [];
    const port = {
      onmessage: null,
      postMessage: (message) => received.push(structuredClone(message)),
    };
    self.onconnect({ ports: [port] });
    return {
      received,
      send: (message) => port.onmessage({ data: message }),
      open: (id, channel) => port.onmessage({ data: { op: "open", id, channel } }),
      close: (id) => port.onmessage({ data: { op: "close", id } }),
    };
  }

  return {
    context,
    sources,
    posts,
    probes,
    requests,
    flushes,
    connectTab,
    get source() {
      return sources.at(-1);
    },
    releaseLock: (name) => locks.get(name)?.(),
  };
}

const running = { kind: "running" };
const session = (sessionId) => ({ kind: "session", sessionId });
const subscribedIds = (posts, connectionId) =>
  posts.filter((post) => post.connectionId === connectionId && post.subscribe).map((post) => post.subscribe.id);

// Instrumentation: the worker buffers samples until a flush POSTs them.

/** The samples of `metric` recorded and not flushed yet, oldest first (copied out of the context). */
const recorded = (worker, metric) =>
  Array.from(vm.runInContext("samples", worker.context), (sample) => ({ ...sample })).filter((sample) => sample.metric === metric);
const pick = (sample, keys) => Object.fromEntries(keys.map((key) => [key, sample[key]]));

/** A frame payload whose JSON is exactly `length` characters. */
function payload(length) {
  const body = { x: "" };
  body.x = "x".repeat(length - JSON.stringify(body).length);
  return body;
}
test("every tab's streams share one EventSource and frames reach only their own stream", async () => {
  const worker = loadWorker();
  const tabA = worker.connectTab();
  const tabB = worker.connectTab();
  tabA.open(1, running);
  tabB.open(1, running);
  tabB.open(2, session("abc"));
  assert.equal(worker.sources.length, 1, "one socket regardless of tabs and streams");
  assert.equal(worker.posts.length, 0, "subscriptions wait for the connection id");

  worker.source.hello("c1");
  await flush();
  const [subA, subB1, subB2] = subscribedIds(worker.posts, "c1");
  assert.deepEqual(worker.posts.find((post) => post.subscribe?.id === subB2).subscribe.channel, session("abc"));

  for (const sub of [subA, subB1, subB2]) worker.source.dispatch("mux", { type: "open", sub });
  worker.source.dispatch(subB2, "{\"type\":\"connected\"}");
  worker.source.dispatch(subA, "{\"type\":\"running\"}");

  assert.deepEqual(tabA.received, [{ id: 1, type: "open" }, { id: 1, type: "message", data: "{\"type\":\"running\"}" }]);
  assert.deepEqual(tabB.received, [
    { id: 1, type: "open" },
    { id: 2, type: "open" },
    { id: 2, type: "message", data: "{\"type\":\"connected\"}" },
  ]);
});

test("a refused subscription fails only its own stream as CLOSED", async () => {
  const worker = loadWorker({
    respond: (body) => body.subscribe?.channel.kind === "session"
      ? { status: 409, body: { error: "Session is not managed by tau", code: "session_not_managed" } }
      : { status: 200, body: { ok: true } },
  });
  const tab = worker.connectTab();
  tab.open(1, running);
  tab.open(2, session("file-only"));
  worker.source.hello("c1");
  await flush();
  await flush();
  assert.deepEqual(tab.received, [{ id: 2, type: "error", readyState: 2 }]);

  const [runningSub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub: runningSub });
  assert.deepEqual(tab.received.at(-1), { id: 1, type: "open" });
  assert.equal(worker.source.closed, false);
});

test("a dropped socket reports CONNECTING and the next hello re-subscribes every stream", async () => {
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, running);
  tab.open(2, session("abc"));
  worker.source.hello("c1");
  await flush();
  for (const sub of subscribedIds(worker.posts, "c1")) worker.source.dispatch("mux", { type: "open", sub });
  tab.received.length = 0;

  worker.source.drop(0); // EventSource auto-reconnects
  assert.deepEqual(tab.received, [
    { id: 1, type: "error", readyState: 0 },
    { id: 2, type: "error", readyState: 0 },
  ]);

  worker.source.hello("c2");
  await flush();
  const resubscribed = subscribedIds(worker.posts, "c2");
  assert.equal(resubscribed.length, 2, "both streams re-subscribe on the new connection");
  for (const sub of resubscribed) worker.source.dispatch("mux", { type: "open", sub });
  assert.deepEqual(tab.received.slice(2), [{ id: 1, type: "open" }, { id: 2, type: "open" }]);
  assert.equal(worker.sources.length, 1, "a recoverable drop reuses EventSource's own reconnect");
});

test("a server restart between hello and subscribe reconnects with a fresh socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let restarted = true;
  const worker = loadWorker({
    respond: () => restarted
      ? { status: 404, body: { error: "Unknown event stream connection", code: "unknown_connection" } }
      : { status: 200, body: { ok: true } },
  });
  const tab = worker.connectTab();
  tab.open(1, running);
  const first = worker.source;
  first.hello("stale");
  await flush();
  await flush();
  assert.equal(first.closed, true);

  restarted = false;
  t.mock.timers.tick(1000);
  assert.equal(worker.sources.length, 2);
  worker.source.hello("fresh");
  await flush();
  assert.equal(subscribedIds(worker.posts, "fresh").length, 1);
});

test("a server-ended subscription reconnects after the EventSource retry delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, { kind: "file", path: "/w/notes.txt", sessionId: null });
  worker.source.hello("c1");
  await flush();
  const [sub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub });
  worker.source.dispatch("mux", { type: "end", sub });
  assert.deepEqual(tab.received.at(-1), { id: 1, type: "error", readyState: 0 });

  t.mock.timers.tick(2999);
  assert.equal(subscribedIds(worker.posts, "c1").length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(subscribedIds(worker.posts, "c1"), [sub, sub]);
});

test("a file watch remains reconnecting through host-offline refusal and opens again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let offline = false;
  const worker = loadWorker({ respond: () => offline
    ? { status: 503, body: { code: "host_offline", error: "The file's host is offline" } }
    : { status: 200, body: { ok: true } } });
  const channel = { kind: "file", path: "/same/report.txt", hostId: "remote", sessionId: null };
  const tab = worker.connectTab();
  tab.open(1, channel);
  worker.source.hello("c1");
  await flush();
  const [sub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub });
  worker.source.dispatch("mux", { type: "end", sub });
  offline = true;
  t.mock.timers.tick(3000); await flush();
  assert.equal(errors(tab).at(-1).readyState, 0, "a transient host outage must not close the tab's file stream");
  offline = false;
  t.mock.timers.tick(3000); await flush();
  worker.source.dispatch("mux", { type: "open", sub });
  worker.source.dispatch(sub, { type: "change", size: 17 });
  assert.equal(errors(tab).at(-1).type, "open");
  assert.equal(JSON.parse(tab.received.at(-1).data).size, 17);
});

test("a dead tab's subscriptions are released and the last stream frees the socket", async () => {
  const worker = loadWorker();
  const tabA = worker.connectTab();
  const tabB = worker.connectTab();
  tabA.send({ op: "lock", name: "tab-a" });
  tabA.open(1, running);
  tabB.open(1, running);
  worker.source.hello("c1");
  await flush();
  const [subA, subB] = subscribedIds(worker.posts, "c1");

  worker.releaseLock("tab-a"); // tab A crashed or was closed
  await flush();
  assert.deepEqual(worker.posts.filter((post) => post.unsubscribe).map((post) => post.unsubscribe), [subA]);
  worker.source.dispatch(subA, "{}");
  assert.deepEqual(tabA.received, [], "a dead tab receives nothing");
  assert.equal(worker.source.closed, false, "the surviving tab keeps the socket");

  tabB.send({ op: "bye" });
  assert.equal(worker.source.closed, true, "no subscriptions left: the socket is released");
  worker.source.dispatch(subB, "{}");
  assert.deepEqual(tabB.received, []);

  tabB.open(2, running);
  assert.equal(worker.sources.length, 2, "a later stream reopens the socket on demand");
});

const TIMERS = { apis: ["setTimeout", "setInterval", "Date"] };

const errors = (tab) => tab.received.filter((message) => message.type === "error" || message.type === "open");

/**
 * POST /api/agent/<session> held until the test answers: `respond` goes to loadWorker, `cmds()` lists what was posted
 * as { rid, session, command }, `reply(rid, status, body)` answers one (status 0: the request fails without an answer).
 */
function agentServer() {
  const held = [];
  return {
    respond: (command, _init, url) => new Promise((resolve, reject) => held.push({
      rid: held.length, session: decodeURIComponent(url.split("/").pop()), command, resolve, reject,
    })),
    cmds: () => held.map(({ rid, session, command }) => ({ rid, session, command })),
    reply: (rid, status, body) => status === 0 ? held[rid].reject(new TypeError("Failed to fetch")) : held[rid].resolve({ status, body }),
  };
}

// Measurement.

test("SSE: three clock probes after hello and one every 10 s; the first snapshot is recorded with the first clock; lastEventId gives event samples", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ serverOffset: 2_000 });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c1");
  assert.deepEqual(worker.requests.slice(0, 2), ["POST /api/events", "GET /api/transport-metrics"],
    "the subscribes go first: on HTTP/1.1 a probe ahead would hold one of the 6 connections first paint needs");
  const [sub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub });
  // The snapshot arrives before the first probe's answer.
  worker.source.dispatch(sub, { n: 1 }, String(Date.now() + 2_000 - 7));
  assert.deepEqual(recorded(worker, "event"), []);
  await flush();
  assert.equal(worker.probes.length, 3, "three GET /api/transport-metrics after the hello");
  const [event] = recorded(worker, "event");
  assert.deepEqual(pick(event, ["transport", "socket", "conn", "sockets", "channel", "offset", "offsetRtt"]), {
    transport: "sse", socket: "sse", conn: "sse", sockets: 1, channel: "running", offset: 2_000, offsetRtt: 0,
  });
  assert.equal(event.gotAt + event.offset - event.at, 7);
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(worker.probes.length, 3);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(worker.probes.length, 4);

  // The EventSource drops: one reconnect sample, from the error to the first open after the next hello (which probes again).
  t.mock.timers.tick(5_000);
  const droppedAt = Date.now();
  worker.source.drop(0);
  t.mock.timers.tick(700);
  worker.source.hello("c2");
  await flush();
  assert.equal(worker.probes.length, 7);
  assert.deepEqual(recorded(worker, "reconnect"), []);
  const [again] = subscribedIds(worker.posts, "c2");
  worker.source.dispatch("mux", { type: "open", sub: again });
  assert.deepEqual(recorded(worker, "reconnect").map((sample) => pick(sample, ["socket", "conn", "trigger", "dropAt", "startAt", "firstFrameAt", "batch"])), [
    { socket: "sse", conn: "sse", trigger: "error", dropAt: droppedAt, startAt: droppedAt, firstFrameAt: droppedAt + 700, batch: 1 },
  ]);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(worker.probes.length, 8, "one probe chain per connection: the dropped connection's stopped");
});

test("a clock probe that never answers is abandoned after 10 s: the probe chain goes on", async (t) => {
  t.mock.timers.enable(TIMERS);
  let hang = true;
  const worker = loadWorker({ metricsHang: () => hang });
  worker.connectTab().open(1, running);
  worker.source.hello("c1");
  await flush();
  assert.equal(worker.probes.length, 1, "the first probe is waiting");
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(worker.probes.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(worker.probes.length, 2, "its deadline passed: the chain sends its second probe");
  hang = false;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(worker.probes.length, 3, "the second was abandoned too: the third, now answered, ends the chain's three");
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(worker.probes.length, 4, "then one every 10 s");
});

test("a sample POST that never answers is abandoned after 10 s: its samples are kept and the next flush sends them", async (t) => {
  t.mock.timers.enable(TIMERS);
  let hang = true;
  const worker = loadWorker({ metricsHang: () => hang });
  const tab = worker.connectTab();
  tab.send({ op: "metric", sample: { metric: "test", n: 0 } });
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(worker.flushes.length, 1, "the POST is waiting");
  t.mock.timers.tick(10_500);
  await flush();
  assert.deepEqual(recorded(worker, "test").map((sample) => sample.n), [0], "abandoned: kept");
  hang = false;
  t.mock.timers.tick(30_000);
  await flush();
  assert.deepEqual(worker.flushes.at(-1).filter((sample) => sample.metric === "test").map((sample) => sample.n), [0], "sent again, not stuck behind the hung one");
  assert.deepEqual(recorded(worker, "test"), []);
});

test("a sample POST has 10 s plus its body at 2 KB/s: a big batch on a slow link is not abandoned at 10 s", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ metricsHang: () => true });
  const tab = worker.connectTab();
  for (let n = 0; n < 200; n++) tab.send({ op: "metric", sample: { metric: "test", n, pad: "x".repeat(1_000) } });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(worker.flushes.length, 1, "the POST of the full batch is waiting");
  const length = JSON.stringify({ samples: worker.flushes[0] }).length;
  assert.ok(length > 200_000);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(recorded(worker, "test").length, 0, "still waiting after 10 s: its samples are not back in the buffer");
  t.mock.timers.tick(length / 2);
  await flush();
  assert.equal(recorded(worker, "test").length, 200, "abandoned at 10 s + body / 2 KB/s: kept for the next flush");
});

test("an event behind another session's large frame records behindOtherBytes and is sampled despite the 1/s limit", async (t) => {
  t.mock.timers.enable(TIMERS);
  // Session a's 100 000-char frame was written at T and arrived at T + 50; b's, written at T + 10, came right behind it.
  const behind = (deliver) => {
    deliver("a", Date.now() - 50, payload(100_000));
    deliver("b", Date.now() - 40, { n: 1 });
  };
  const isolation = (worker) => recorded(worker, "event").map((sample) => [sample.bytes, sample.behindSameBytes, sample.behindOtherBytes]);
  const sharedPipe = [[100_000, 0, 0], [7, 0, 100_000]];

  const sse = loadWorker();
  const tab = sse.connectTab();
  tab.open(1, session("a"));
  tab.open(2, session("b"));
  sse.source.hello("c1");
  await flush();
  const [aSub, bSub] = subscribedIds(sse.posts, "c1");
  for (const sub of [aSub, bSub]) sse.source.dispatch("mux", { type: "open", sub });
  behind((sessionId, at, data) => sse.source.dispatch(sessionId === "a" ? aSub : bSub, data, String(at)));
  assert.deepEqual(isolation(sse), sharedPipe, "sse");
});

test("samples flush at 200 or every 30 s, survive a failed POST, cap at 2 000 and report dropped", async (t) => {
  t.mock.timers.enable(TIMERS);
  let status = 200;
  const worker = loadWorker({ metricsStatus: () => status });
  const tab = worker.connectTab();
  const metric = (n) => tab.send({ op: "metric", sample: { metric: "test", n } });
  const numbers = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

  metric(0);
  t.mock.timers.tick(29_999);
  assert.equal(worker.flushes.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(worker.flushes.map((batch) => batch.map((sample) => sample.n)), [[0]], "30 s after the first sample");

  for (let n = 1; n <= 200; n++) metric(n);
  assert.equal(worker.flushes.length, 1, "not on the path that recorded the 200th sample");
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(worker.flushes[1].map((sample) => sample.n), numbers(1, 201), "at 200, right after");

  status = 503;
  for (let n = 201; n < 2_301; n++) metric(n);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(worker.flushes.length, 3, "one POST at 200, which failed; no retry per sample after it");
  assert.deepEqual(recorded(worker, "test").map((sample) => sample.n), numbers(301, 2_301), "kept; above 2 000 the oldest are dropped");

  status = 200;
  t.mock.timers.tick(30_000);
  await flush();
  const after = worker.flushes.slice(3);
  assert.ok(after.every((batch) => batch.length <= 201), "at most 200 samples and the dropped count per POST");
  assert.deepEqual(after.flat().filter((sample) => sample.metric === "test").map((sample) => sample.n), numbers(301, 2_301));
  assert.deepEqual(after[0].at(-1).metric, "dropped");
  assert.deepEqual(after.flat().filter((sample) => sample.metric === "dropped").map((sample) => pick(sample, ["count", "socket", "conn"])), [{ count: 100, socket: "worker", conn: "worker" }]);
  assert.deepEqual(recorded(worker, "test"), []);
});

test("an HTTP action's reply is measured against the large frames of the SSE stream it shares a connection with", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, session("a"));
  worker.source.hello("c1");
  await flush();
  const [aSub] = subscribedIds(worker.posts, "c1");
  worker.source.dispatch("mux", { type: "open", sub: aSub });
  // Session a's 100 000-char frame, written 50 ms ago, arrives now.
  const arrived = Date.now();
  worker.source.dispatch(aSub, payload(100_000), String(arrived - 50));
  t.mock.timers.tick(5);
  const action = (sessionId, fields) =>
    tab.send({ op: "metric", sample: { metric: "action", req: `r-${sessionId}`, type: "get_state", session: sessionId, via: "http", socket: "http", gotAt: Date.now(), ...fields } });
  action("b", { repliedAt: arrived - 40, replyBehindOtherBytes: null });
  action("a", { repliedAt: arrived - 40, replyBehindOtherBytes: null });
  action("c", { repliedAt: arrived + 1, replyBehindOtherBytes: null });
  action("d", { repliedAt: null, replyBehindOtherBytes: null });
  assert.deepEqual(recorded(worker, "action").map((sample) => [sample.session, sample.replyBehindOtherBytes]), [["b", 100_000], ["a", 0], ["c", 0], ["d", null]]);
});

test("every sample carries clientId, effectiveType and visible", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  worker.context.self.navigator.connection = { effectiveType: "3g" };
  const tab = worker.connectTab();
  const other = worker.connectTab();
  tab.send({ op: "wake", reason: "hidden", visible: false, clientId: "client-9" });
  tab.send({ op: "metric", sample: { metric: "test", n: 1 } });
  other.send({ op: "wake", reason: "init", visible: true, clientId: "client-9" });
  tab.send({ op: "metric", sample: { metric: "test", n: 2 } });
  assert.deepEqual(recorded(worker, "test").map((sample) => pick(sample, ["n", "clientId", "effectiveType", "visible", "transport", "socket", "conn", "sockets"])), [
    { n: 1, clientId: "client-9", effectiveType: "3g", visible: false, transport: "sse", socket: "worker", conn: "worker", sockets: 0 },
    { n: 2, clientId: "client-9", effectiveType: "3g", visible: true, transport: "sse", socket: "worker", conn: "worker", sockets: 0 },
  ]);
});

const diag = (tab, n) => {
  tab.send({ op: "diag", n });
  return tab.received.filter((message) => message.diag === n).at(-1)?.data;
};

test("diag: the EventSource in use, its outage turning to down after 15 s, and stats of the last 30 min only", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c1");
  // Server clock = tab clock: 10 ms up, 15 ms on the server, 40 ms in all.
  const action = { metric: "action", outcome: "ok", type: "get_state", sentAt: 0, gotAt: 40, recvAt: 10, repliedAt: 25, offset: 0 };
  tab.send({ op: "metric", sample: action });
  const first = diag(tab, 1);
  assert.deepEqual(pick(first, ["status", "since", "windowMs"]), { status: "connected", since: null, windowMs: 1_800_000 });
  assert.deepEqual(first.stats.filter((row) => row.transport === "sse").map((row) => [row.metric, row.count, row.max]), [["upMs", 1, 10], ["transportMs", 1, 25], ["ompMs", 1, 15], ["serverMs", 1, 15], ["totalMs", 1, 40]]);

  const droppedAt = Date.now();
  worker.source.drop(0);
  assert.deepEqual(pick(diag(tab, 2), ["status", "since"]), { status: "connecting", since: droppedAt });
  t.mock.timers.tick(15_000);
  assert.equal(diag(tab, 3).status, "down");

  t.mock.timers.tick(30 * 60_000 - 15_000);
  assert.equal(diag(tab, 4).stats.find((row) => row.metric === "totalMs").count, 1, "still within the window at 30 minutes");
  t.mock.timers.tick(1);
  assert.deepEqual(diag(tab, 5).stats, [], "aged out after 30 minutes");
});

test("diag: SSE is idle without subscriptions, and its initial attempt ends only at hello", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = worker.connectTab();
  assert.deepEqual(pick(diag(tab, 1), ["status", "since"]), { status: "idle", since: null });
  tab.open(1, running);
  const startedAt = Date.now();
  t.mock.timers.tick(15_000);
  assert.deepEqual(pick(diag(tab, 2), ["status", "since"]), { status: "down", since: startedAt });
  worker.source.hello("c0");
  assert.deepEqual(pick(diag(tab, 3), ["status", "since"]), { status: "connected", since: null });
  tab.close(1);
  t.mock.timers.tick(15_000);
  assert.deepEqual(pick(diag(tab, 4), ["status", "since"]), { status: "idle", since: null });
  tab.open(2, running);
  assert.deepEqual(pick(diag(tab, 5), ["status", "since"]), { status: "connecting", since: Date.now() });
});

test("diag: more than 20,000 samples keeps only the newest samples", (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker();
  const tab = worker.connectTab();
  const action = { metric: "action", outcome: "ok", type: "get_state", sentAt: 0, recvAt: 10, repliedAt: 25, offset: 0 };
  tab.send({ op: "metric", sample: { ...action, gotAt: 100 } });
  for (let index = 0; index < 20_000; index++) tab.send({ op: "metric", sample: { ...action, gotAt: 40 } });
  const total = diag(tab, 1).stats.find((row) => row.metric === "totalMs");
  assert.deepEqual(pick(total, ["count", "mean", "max"]), { count: 20_000, mean: 40, max: 40 }, "the oldest outlier was evicted");
});

test("the production bundle is a classic script without AbortSignal.timeout, AbortSignal.any or Promise.withResolvers", async () => {
  const bundle = await buildEventStreamWorker(fileURLToPath(new URL("..", import.meta.url)));
  for (const forbidden of ["AbortSignal.timeout", "AbortSignal.any", "withResolvers", "import.meta"]) assert.ok(!bundle.includes(forbidden), forbidden);
  assert.doesNotThrow(() => new vm.Script(bundle), "parses as a classic script (no import/export)");
  assert.match(bundle, /^\(\(\)=>\{/, "wrapped: its names stay out of the worker's global scope");
});

// ---- Uploads (docs/specs/2026-11-02-file-uploads-design.md U4) ----

const UPLOAD_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
/** Lets the worker's File reads (real promises) settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await flush();
}

const deletes = (worker) => worker.requests.filter((request) => request.startsWith("DELETE"));
const DELETE_URL = `DELETE /api/uploads/${UPLOAD_ID}?host=h1`;

test("a DELETE that never answers is abandoned after 40 s and retried after the back-off; a wake meanwhile starts no second one", async (t) => {
  t.mock.timers.enable(TIMERS);
  let hang = true;
  const worker = loadWorker({ deleteHang: () => hang, deleteStatus: () => 204 });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c0");
  tab.send({ op: "up_abort", id: UPLOAD_ID, host: "h1" });
  await flush();
  assert.equal(deletes(worker).length, 1);
  t.mock.timers.tick(39_999);
  tab.send({ op: "wake", reason: "online", visible: true, clientId: "c" });
  await flush();
  assert.equal(deletes(worker).length, 1, "the request in flight is not doubled by a wake");
  hang = false;
  t.mock.timers.tick(1);
  await flush();
  assert.equal(deletes(worker).length, 1, "abandoned, now waiting out the back-off");
  t.mock.timers.tick(4_999);
  await flush();
  assert.equal(deletes(worker).length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(deletes(worker).length, 2, "retried after the back-off");
  t.mock.timers.tick(300_000);
  await flush();
  assert.equal(deletes(worker).length, 2, "the 204 settled it");
});

test("over SSE a 408 and a 429 are retried like a 5xx; other 4xx settle", async (t) => {
  for (const [status, retried] of [[408, true], [429, true], [400, false], [403, false]]) {
    t.mock.timers.enable(TIMERS);
    const worker = loadWorker({ deleteStatus: () => status });
    const tab = worker.connectTab();
    tab.open(1, running);
    worker.source.hello("c0");
    tab.send({ op: "up_abort", id: UPLOAD_ID, host: "h1" });
    await flush();
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(deletes(worker).length, retried ? 2 : 1, `${status}: ${retried ? "retried" : "settled"}`);
    t.mock.timers.reset();
  }
});

test("an upload under the id of an abort whose DELETE failed cancels the abort: no retry DELETEs the new upload", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ deleteStatus: () => 503 });
  const tab = worker.connectTab();
  tab.send({ op: "up_abort", id: UPLOAD_ID, host: "h1" });
  await flush();
  assert.deepEqual(deletes(worker), [DELETE_URL], "failed, waiting for its retry");
  tab.send({ op: "upload", id: UPLOAD_ID });
  t.mock.timers.tick(5_000);
  await flush();
  tab.send({ op: "wake", reason: "online", visible: true, clientId: "c" });
  await flush();
  assert.deepEqual(deletes(worker), [DELETE_URL], "neither the back-off nor the wake deletes it again");
});

test("over SSE a DELETE that fails is retried after 5 s, 15 s, 60 s and at once on a wake; a 204 settles it", async (t) => {
  t.mock.timers.enable(TIMERS);
  let status = 0;
  const worker = loadWorker({ deleteStatus: () => status });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c0");
  tab.send({ op: "up_abort", id: UPLOAD_ID, host: "h1" });
  await flush();
  assert.deepEqual(deletes(worker), [DELETE_URL], "a network error");
  t.mock.timers.tick(4_999);
  await flush();
  assert.equal(deletes(worker).length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(deletes(worker).length, 2, "after 5 s");
  status = 503;
  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(deletes(worker).length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(deletes(worker).length, 3, "after 15 s more, answered 503");
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(deletes(worker).length, 3);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(deletes(worker).length, 4, "after 60 s more");
  status = 204;
  tab.send({ op: "wake", reason: "online", visible: true, clientId: "c" });
  await flush();
  assert.equal(deletes(worker).length, 5, "at once on a wake");
  t.mock.timers.tick(300_000);
  await flush();
  assert.equal(deletes(worker).length, 5, "settled");
});

test("over SSE a 404 settles a DELETE too", async (t) => {
  t.mock.timers.enable(TIMERS);
  const worker = loadWorker({ deleteStatus: () => 404 });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c0");
  tab.send({ op: "up_abort", id: UPLOAD_ID, host: "h1" });
  await flush();
  t.mock.timers.tick(300_000);
  await flush();
  assert.deepEqual(deletes(worker), [DELETE_URL]);
});

test("at most 256 aborts stay pending: the oldest is dropped", async (t) => {
  t.mock.timers.enable(TIMERS);
  let status = 503;
  const worker = loadWorker({ deleteStatus: () => status });
  const tab = worker.connectTab();
  tab.open(1, running);
  worker.source.hello("c0");
  for (let i = 0; i < 257; i++) tab.send({ op: "up_abort", id: `id${i}`, host: "h1" });
  await flush();
  worker.requests.length = 0;
  status = 204;
  tab.send({ op: "wake", reason: "online", visible: true, clientId: "c" });
  await flush();
  assert.equal(deletes(worker).length, 256);
  assert.equal(deletes(worker).includes("DELETE /api/uploads/id0?host=h1"), false);
});

// The message outbox's first leg (docs/specs/2026-11-04-message-outbox-design.md O2).


// Real time, fixed: entries stay well within the 7 days whether or not a test mocks Date.
const NOW = Date.now();
const outboxEntry = (id, sessionId = "a", createdAt = NOW) => ({ id, sessionId, scope: "test-scope", mode: "prompt", message: `hi ${id}`, createdAt });
const outboxMessages = (tab) => tab.received.filter((message) => "outbox" in message || "outboxAdded" in message || "outboxStored" in message);
const acceptedM1 = { success: true, data: { entry: { id: "m1", sessionId: "a", mode: "prompt", message: "hi m1", state: "held", createdAt: NOW } } };
const acceptedM2 = { success: true, data: { entry: { id: "m2", sessionId: "a", mode: "prompt", message: "hi m2", state: "held", createdAt: NOW } } };

test("upload continuity: persisted completion proof authorizes the restarted worker's first leg", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const first = loadWorker({ indexedDB: idb, respond: () => ({ status: 503, body: {} }) });
  const tab = first.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: {
    ...outboxEntry("proof-first"), uploads: [UPLOAD_ID], uploadProofs: { [UPLOAD_ID]: "persisted-completion-proof" },
  } });
  tab.send({ op: "outbox_add", n: 2, entry: outboxEntry("proof-later") });
  await settle();
  assert.equal(idb.entries.size, 2, "both intents committed before the old worker disappears");

  const authorized = (body) => body.uploads?.[0] === UPLOAD_ID && body.uploadProofs?.[UPLOAD_ID] === "persisted-completion-proof";
  const receipt = { success: true, data: { entry: { ...outboxEntry("proof-first"), uploads: [UPLOAD_ID], state: "held" } } };
  const restarted = loadWorker({ indexedDB: idb, respond: (body) => body.id !== "proof-first"
    ? { status: 503, body: {} }
    : authorized(body) ? { status: 200, body: receipt } : { status: 403, body: { error: "Upload belongs to the previous login" } } });
  const receiver = restarted.connectTab();
  await settle();
  assert.equal(idb.entries.has("proof-first"), false, "the resumed prepared command must retain the completed file's authorization");
  assert.equal(idb.entries.has("proof-later"), true, "the head's receipt cannot accept the later message");
  assert.deepEqual(receiver.received.find((message) => message.outboxStored)?.outboxStored, receipt.data.entry, "the public receipt contains no private proof");
});

test("outbox: a matching delivered tombstone with empty message is authoritative acceptance", async () => {
  const idb = fakeIndexedDB();
  const tombstone = { success: true, data: { entry: { id: "m1", sessionId: "canonical-session", mode: "prompt", message: "", state: "delivered", createdAt: 1, images: [], uploads: [], error: "", mayHaveBeenSent: false } } };
  const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 200, body: tombstone }) });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  assert.equal(idb.entries.size, 0);
  assert.deepEqual(tab.received.find((message) => "outboxStored" in message).outboxStored, tombstone.data.entry);
});

test("outbox: a delivered native receipt retains the exact original intent without leaking private proof", async () => {
  const idb = fakeIndexedDB();
  const images = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
  const uploads = [UPLOAD_ID];
  const tombstone = { success: true, data: { entry: {
    id: "m1", sessionId: "canonical-session", mode: "prompt", message: "", state: "delivered", createdAt: 1, settlement: "native",
  } } };
  const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 200, body: tombstone }) });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: { ...outboxEntry("m1"), images, uploads, uploadProofs: { [UPLOAD_ID]: "private-completion-proof" } } });
  await flush();
  assert.equal(idb.entries.size, 0, "server acceptance consumes durable first-leg storage");
  const receipt = tab.received.find((message) => "outboxStored" in message).outboxStored;
  assert.deepEqual(receipt, { ...tombstone.data.entry, message: "hi m1", images, uploads }, "the browser can bridge until that exact native ID is represented");
  assert.equal(Object.hasOwn(receipt, "uploadProofs"), false);
});

test("outbox: malformed settlement metadata cannot consume the durable browser intent", async () => {
  const idb = fakeIndexedDB();
  const invalid = { success: true, data: { entry: { ...acceptedM1.data.entry, state: "delivered", settlement: "guessed" } } };
  const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 200, body: invalid }) });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  assert.equal(idb.entries.get("m1")?.state, "sending");
  assert.equal(tab.received.some((message) => "outboxStored" in message), false);
});

test("outbox: legacy rows keep a deterministic fallback before sequenced adds without a database upgrade", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  idb.entries.set("z-legacy", { ...outboxEntry("z-legacy"), state: "sending" });
  idb.entries.set("a-legacy", { ...outboxEntry("a-legacy"), state: "sending" });
  const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 503, body: {} }) });
  const tab = worker.connectTab();
  await flush();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("new", "a", NOW - 1000) });
  await flush();
  assert.deepEqual(worker.posts.map((post) => post.id), ["a-legacy"]);
  assert.deepEqual(tab.received.filter((message) => "outbox" in message).at(-1).outbox.map((entry) => entry.id), ["a-legacy", "z-legacy", "new"]);
  assert.equal(idb.entries.get("new").enqueueOrder, 1);
  assert.equal(idb.entries.get("z-legacy").enqueueOrder, undefined, "legacy data is not rewritten");
});

test("outbox: serialized concurrent adds retain enqueue order across clock ties and restart", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const down = () => ({ status: 503, body: {} });
  const first = loadWorker({ indexedDB: idb, respond: down });
  const second = loadWorker({ indexedDB: idb, respond: down });
  const tabA = first.connectTab();
  const tabB = second.connectTab();
  await flush();
  idb.hold = true;
  tabA.send({ op: "outbox_add", n: 1, entry: outboxEntry("z-first") });
  tabB.send({ op: "outbox_add", n: 2, entry: outboxEntry("a-second") });
  await flush();
  assert.equal(idb.entries.size, 0);
  idb.hold = false;
  idb.release();
  await flush();
  assert.equal(idb.entries.get("z-first").enqueueOrder, 1);
  assert.equal(idb.entries.get("a-second").enqueueOrder, 2);
  const restarted = loadWorker({ indexedDB: idb, respond: down });
  const tab = restarted.connectTab();
  await flush();
  assert.deepEqual(restarted.posts.map((post) => post.id), ["z-first"]);
  assert.deepEqual(tab.received.at(-1).outbox.map((entry) => entry.id), ["z-first", "a-second"]);
});

test("outbox: duplicate active ids reject the second composer without replacing the first intent", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const down = () => ({ status: 503, body: {} });
  const first = loadWorker({ indexedDB: idb, respond: down });
  const second = loadWorker({ indexedDB: idb, respond: down });
  const tabA = first.connectTab();
  const tabB = second.connectTab();
  await flush();
  tabA.send({ op: "outbox_add", n: 1, entry: outboxEntry("same-id") });
  tabB.send({ op: "outbox_add", n: 2, entry: { ...outboxEntry("same-id", "other"), message: "new draft" } });
  await flush();
  assert.equal(tabA.received.find((message) => message.outboxAdded === 1).error, undefined);
  assert.equal(typeof tabB.received.find((message) => message.outboxAdded === 2).error, "string");
  assert.equal(idb.entries.get("same-id").message, "hi same-id");
  assert.equal(idb.entries.get("same-id").sessionId, "a");
  assert.equal(second.posts.length, 0);
});

for (const body of [
  null, "<html>login</html>", { ok: true }, { success: true },
  { success: true, data: { entry: { id: "m1", state: "held" } } },
  ...[
    { id: "wrong-id" }, { state: "unknown" }, { sessionId: "" }, { mode: "unknown" }, { message: null }, { createdAt: NaN },
    { images: {} }, { images: [{ type: "image", data: "abc" }] }, { uploads: "not-an-array" }, { uploads: [17] },
    { error: {} }, { mayHaveBeenSent: "yes" },
  ].map((invalid) => ({ success: true, data: { entry: { ...acceptedM1.data.entry, ...invalid } } })),
]) {
  test(`outbox: an unconfirmed 200 retains its stable id and session head (${JSON.stringify(body)})`, async (t) => {
    t.mock.timers.enable(TIMERS);
    const idb = fakeIndexedDB();
    let answer = body;
    const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 200, body: answer }) });
    const tab = worker.connectTab();
    tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
    tab.send({ op: "outbox_add", n: 2, entry: outboxEntry("m2") });
    await flush();
    assert.deepEqual(worker.posts.map((post) => post.id), ["m1"]);
    assert.equal(idb.entries.get("m1").state, "sending");
    assert.equal(idb.entries.size, 2);
    assert.equal(tab.received.some((message) => "outboxStored" in message), false);
    answer = { success: true, data: { entry: { ...acceptedM1.data.entry, sessionId: "canonical-session" } } };
    t.mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(worker.posts.map((post) => post.id), ["m1", "m1", "m2"]);
    assert.equal(idb.entries.has("m1"), false, "a canonical session-id move is a valid acceptance");
    assert.equal(idb.entries.has("m2"), true, "the m1 receipt cannot accept m2");
    assert.deepEqual(tab.received.find((message) => "outboxStored" in message).outboxStored, answer.data.entry);
  });
}

test("outbox: an add is answered once IndexedDB commits it, then POSTed; a 200 deletes it and tells every tab", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const srv = agentServer();
  const worker = loadWorker({ indexedDB: idb, respond: srv.respond });
  const tab = worker.connectTab();
  const other = worker.connectTab();
  await flush();
  idb.hold = true;
  const entry = outboxEntry("m1");
  tab.send({ op: "outbox_add", n: 7, entry });
  await flush();
  assert.deepEqual(outboxMessages(tab), [], "not answered before the commit");
  assert.equal(idb.entries.size, 0);
  assert.deepEqual(srv.cmds(), [], "nor sent");

  idb.hold = false;
  idb.release();
  await flush();
  const sending = { ...entry, state: "sending", enqueueOrder: 1 };
  assert.deepEqual(idb.entries.get("m1"), sending);
  assert.deepEqual(outboxMessages(tab), [{ outbox: [sending] }, { outboxAdded: 7 }]);
  assert.deepEqual(outboxMessages(other), [{ outbox: [sending] }], "every tab hears the list");
  const [cmd] = srv.cmds();
  assert.equal(cmd.session, "a");
  assert.deepEqual(cmd.command, { type: "outbox_add", id: "m1", scope: "test-scope", mode: "prompt", message: "hi m1" });

  const held = { ...entry, state: "held" };
  srv.reply(cmd.rid, 200, { success: true, data: { entry: held } });
  await flush();
  assert.deepEqual(outboxMessages(tab).slice(2), [{ outboxStored: held }, { outbox: [] }]);
  assert.deepEqual(outboxMessages(other).slice(1), [{ outboxStored: held }, { outbox: [] }]);
  assert.equal(idb.entries.size, 0, "deleted from IndexedDB");
});

test("outbox: a Retry's copy names the entry it replaces; its 200 deletes that failed original in the same commit", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  idb.entries.set("orig", { ...outboxEntry("orig"), message: "same retry intent", state: "failed", error: "refused", enqueueOrder: 1 });
  const srv = agentServer();
  const worker = loadWorker({ indexedDB: idb, respond: srv.respond });
  const tab = worker.connectTab();
  await flush();
  tab.send({ op: "outbox_add", n: 1, entry: { ...outboxEntry("copy"), message: "same retry intent", replaces: "orig" } });
  await flush();
  const [cmd] = srv.cmds();
  assert.deepEqual(cmd.command, { type: "outbox_add", id: "copy", scope: "test-scope", mode: "prompt", message: "same retry intent", replaces: "orig" });
  const held = { ...outboxEntry("copy"), message: "same retry intent", state: "held", replaces: "orig" };
  srv.reply(cmd.rid, 200, { success: true, data: { entry: held } });
  await flush();
  assert.deepEqual([...idb.entries.keys()], [], "the copy and the original it replaced leave IndexedDB together");
  assert.deepEqual(outboxMessages(tab).slice(-2), [{ outboxStored: { ...held, replaces: "orig" } }, { outbox: [] }]);
});
test("outbox: concurrent workers reuse one exact retry copy from the shared IndexedDB transaction", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const sessionId = "retry-race-session";
  const root = {
    ...outboxEntry("race-root", sessionId), message: "same retry intent", uploads: ["retry-file"],
    uploadProofs: { "retry-file": "retry-proof" }, state: "failed", error: "refused", enqueueOrder: 1,
  };
  idb.entries.set(root.id, root);
  const srv = agentServer();
  const secondSrv = agentServer();
  const tab = loadWorker({ indexedDB: idb, respond: srv.respond }).connectTab();
  const secondTab = loadWorker({ indexedDB: idb, respond: secondSrv.respond }).connectTab();
  await flush();

  tab.send({ op: "outbox_add", n: 1, entry: { ...outboxEntry("race-copy-a", sessionId), message: root.message, uploads: root.uploads, uploadProofs: root.uploadProofs, replaces: root.id } });
  secondTab.send({ op: "outbox_add", n: 1, entry: { ...outboxEntry("race-copy-b", sessionId), message: root.message, uploads: root.uploads, uploadProofs: root.uploadProofs, replaces: root.id } });
  await flush();

  const firstPosts = srv.cmds().filter(({ command }) => command.type === "outbox_add");
  const secondPosts = secondSrv.cmds().filter(({ command }) => command.type === "outbox_add");
  const posts = [...firstPosts, ...secondPosts];
  assert.ok(posts.length > 0);
  assert.deepEqual(new Set(posts.map(({ command }) => command.id)), new Set(["race-copy-a"]), "workers may replay, but never allocate a second runnable ID");
  assert.deepEqual(posts[0].command.uploadProofs, root.uploadProofs, "the shared retry retains its original attachment proof");
  assert.deepEqual([...idb.entries.keys()].sort(), ["race-copy-a", root.id]);
  for (const client of [tab, secondTab]) {
    assert.deepEqual(
      outboxMessages(client).filter((message) => "outbox" in message).at(-1).outbox.map((entry) => entry.id),
      [root.id, "race-copy-a"],
      "both workers publish the single durable retry before either composer relies on a list refresh",
    );
    assert.equal(outboxMessages(client).filter((message) => message.outboxAdded === 1).length, 1);
  }

  for (const post of firstPosts) srv.reply(post.rid, 404, { code: "upload_missing", error: "The upload is gone" });
  for (const post of secondPosts) secondSrv.reply(post.rid, 404, { code: "upload_missing", error: "The upload is gone" });
  await flush();
  assert.deepEqual([...idb.entries.keys()].sort(), ["race-copy-a", root.id]);
  assert.equal(idb.entries.get(root.id).state, "failed");
  assert.equal(idb.entries.get("race-copy-a").state, "failed");
});
test("outbox: a reused sending copy is sent when the peer that stored it never drains", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const sessionId = "retry-peer-liveness";
  const root = { ...outboxEntry("peer-root", sessionId), message: "same retry intent", state: "failed", error: "refused" };
  idb.entries.set(root.id, root);

  const ownerPosts = [];
  const owner = loadWorker({
    indexedDB: idb,
    respond: (body) => {
      ownerPosts.push(body);
      return { status: 200, body: { success: true, data: { entry: {
        id: body.id, sessionId, mode: body.mode, message: "", state: "delivered", settlement: "none", createdAt: NOW,
      } } } };
    },
  });
  const ownerTab = owner.connectTab();
  await flush();

  const peerPosts = [];
  let answerPeer;
  const peer = loadWorker({
    indexedDB: idb,
    respond: (body) => {
      peerPosts.push(body);
      return new Promise((resolve) => { answerPeer = resolve; });
    },
  });
  const peerTab = peer.connectTab();
  await flush();
  peerTab.send({ op: "outbox_add", n: 1, entry: { ...outboxEntry("peer-copy", sessionId), message: root.message, replaces: root.id } });
  await flush();
  assert.equal(peerPosts.length, 1);
  assert.equal(idb.entries.get("peer-copy").state, "sending");

  ownerTab.send({ op: "outbox_add", n: 2, entry: { ...outboxEntry("later-copy", sessionId), message: root.message, replaces: root.id } });
  await flush();
  assert.deepEqual(ownerPosts.map(({ id }) => id), ["peer-copy"], "the stale worker sends the shared IDB winner without a wake or new ID");
  assert.deepEqual([...idb.entries.keys()], [], "the accepted receipt retires the root and the peer's local copy");
  assert.equal(ownerTab.received.some((message) => message.outboxAdded === 2), true, "the later hold receives its durable-add acknowledgement");
  const stored = outboxMessages(ownerTab).filter((message) => "outboxStored" in message).at(-1).outboxStored;
  assert.equal(stored.replaces, root.id);

  answerPeer({ status: 404, body: { error: "Late refusal" } });
  await flush();
  assert.deepEqual([...idb.entries.keys()], [], "the peer's late refusal cannot resurrect the accepted copy or root");
});
test("outbox: a server-confirmed local retry copy becomes the anchor for a later retry", async () => {
  const idb = fakeIndexedDB();
  const sessionId = "server-known-retry";
  const root = { ...outboxEntry("browser-root", sessionId), message: "server accepted this copy", state: "failed" };
  const acceptedCopy = { ...outboxEntry("accepted-copy", sessionId), message: root.message, state: "failed", replaces: root.id };
  const sibling = { ...outboxEntry("old-sibling", sessionId), message: root.message, state: "failed", replaces: root.id };
  const differentIntent = { ...outboxEntry("different-intent", sessionId), message: "not the same content", state: "failed", replaces: root.id };
  const sameTextUnrelated = { ...outboxEntry("same-text-unrelated", sessionId), message: root.message, state: "failed" };
  const otherSession = { ...outboxEntry("other-session-copy", "other"), message: root.message, state: "failed", replaces: root.id };
  for (const entry of [root, acceptedCopy, sibling, differentIntent, sameTextUnrelated, otherSession]) idb.entries.set(entry.id, entry);

  const posts = [];
  const worker = loadWorker({ indexedDB: idb, respond: (body) => {
    posts.push(body);
    return { status: 404, body: { error: "The retry was refused" } };
  } });
  const tab = worker.connectTab();
  await flush();

  // This is the server's authoritative snapshot confirming that the browser-only copy was stored.
  const serverSnapshot = [{ id: acceptedCopy.id, sessionId, mode: root.mode, message: root.message, state: "failed" }];
  tab.send({ op: "outbox_reconcile", n: 1, sessionId, confirmedIds: serverSnapshot.map(({ id }) => id) });
  await flush();
  assert.deepEqual(tab.received.find((message) => message.outboxReconciled === 1), { outboxReconciled: 1 });
  assert.deepEqual([...idb.entries.keys()].sort(), ["different-intent", "other-session-copy", "same-text-unrelated"]);

  tab.send({ op: "outbox_add", n: 2, entry: {
    ...outboxEntry("retry-server-copy", sessionId), message: root.message, replaces: acceptedCopy.id,
  } });
  await flush();
  assert.deepEqual(posts.map(({ id, replaces }) => [id, replaces]), [["retry-server-copy", acceptedCopy.id]]);
  assert.deepEqual([...idb.entries.keys()].sort(), ["different-intent", "other-session-copy", "retry-server-copy", "same-text-unrelated"]);
  assert.equal(idb.entries.get("retry-server-copy").state, "failed", "refusal leaves the server-known retry root to the server");
});
test("outbox: server confirmation consumes stale local ancestry and keeps the confirmed ID as retry root", async () => {
  const idb = fakeIndexedDB();
  const sessionId = "promoted-server-root";
  const intent = { message: "server accepted copy", uploads: ["root-file"], uploadProofs: { "root-file": "proof" } };
  const root = { ...outboxEntry("browser-root", sessionId), ...intent, state: "failed", error: "refused" };
  const accepted = { ...outboxEntry("server-copy", sessionId), ...intent, state: "failed", error: "Not sent within 7 days.", replaces: root.id };
  const sibling = { ...outboxEntry("old-sibling", sessionId), ...intent, state: "failed", replaces: root.id };
  const differentIntent = { ...outboxEntry("different-intent", sessionId), ...intent, message: "other content", state: "failed", replaces: root.id };
  const differentUpload = { ...outboxEntry("different-upload", sessionId), message: intent.message, uploads: ["other-file"], state: "failed", replaces: root.id };
  const unrelated = { ...outboxEntry("same-text-unrelated", sessionId), message: intent.message, state: "failed" };
  const crossSession = { ...outboxEntry("cross-session", "other"), ...intent, state: "failed", replaces: root.id };
  const foreignRoot = { ...outboxEntry("foreign-root", "other"), message: "foreign root intent", state: "failed" };
  const foreignCopy = { ...outboxEntry("foreign-copy", sessionId), message: foreignRoot.message, state: "failed", replaces: foreignRoot.id };
  for (const entry of [root, accepted, sibling, differentIntent, differentUpload, unrelated, crossSession, foreignRoot, foreignCopy]) idb.entries.set(entry.id, entry);

  const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 404, body: { error: "Retry refused" } }) });
  const tab = worker.connectTab();
  await flush();
  tab.send({ op: "outbox_reconcile", n: 1, sessionId, confirmedIds: [accepted.id, foreignCopy.id] });
  await flush();

  assert.equal(tab.received.some((message) => message.outboxReconciled === 1), true);
  assert.deepEqual([...idb.entries.keys()].sort(), ["cross-session", "different-intent", "different-upload", "foreign-root", "same-text-unrelated"]);

  tab.send({ op: "outbox_add", n: 2, entry: {
    ...outboxEntry("retry-server-copy", sessionId), message: intent.message, uploads: intent.uploads, uploadProofs: intent.uploadProofs, replaces: accepted.id,
  } });
  await flush();
  assert.deepEqual(worker.posts.map(({ id, replaces }) => [id, replaces]), [["retry-server-copy", accepted.id]]);
  assert.equal(idb.entries.get("retry-server-copy").state, "failed");
  assert.equal(idb.entries.has(root.id), false);
  assert.equal(idb.entries.has(accepted.id), false);
});
test("outbox: failed server-root reconciliation preserves local C and O", async () => {
  const idb = fakeIndexedDB();
  const sessionId = "failed-root-reconcile";
  const root = { ...outboxEntry("failed-reconcile-root", sessionId), message: "same intent", state: "failed" };
  const copy = { ...outboxEntry("failed-reconcile-copy", sessionId), message: root.message, state: "failed", replaces: root.id };
  idb.entries.set(root.id, root);
  idb.entries.set(copy.id, copy);
  const worker = loadWorker({ indexedDB: idb });
  const tab = worker.connectTab();
  await flush();

  idb.failWrites = true;
  tab.send({ op: "outbox_reconcile", n: 1, sessionId, confirmedIds: [copy.id] });
  await flush();

  const answer = tab.received.find((message) => message.outboxReconciled === 1);
  assert.equal(typeof answer.error, "string");
  assert.deepEqual([...idb.entries.keys()].sort(), [copy.id, root.id]);
});
test("outbox: reconciliation deletes a confirmed ordinary local ID only in its owning session", async () => {
  const idb = fakeIndexedDB();
  const sessionId = "confirmed-ordinary-local";
  const accepted = { ...outboxEntry("accepted-ordinary-local", sessionId), state: "failed" };
  const unrelated = { ...outboxEntry("same-session-unrelated", sessionId), message: accepted.message, state: "failed" };
  const otherSession = { ...outboxEntry("other-session-confirmed", "other"), state: "failed" };
  for (const entry of [accepted, unrelated, otherSession]) idb.entries.set(entry.id, entry);

  const worker = loadWorker({ indexedDB: idb });
  const tab = worker.connectTab();
  await flush();
  tab.send({ op: "outbox_reconcile", n: 1, sessionId, confirmedIds: [accepted.id, otherSession.id] });
  await flush();

  assert.equal(tab.received.some((message) => message.outboxReconciled === 1), true);
  assert.deepEqual([...idb.entries.keys()].sort(), [otherSession.id, unrelated.id].sort());
});

test("outbox: reconciliation refreshes rows a peer already removed before acknowledging the tab", async () => {
  const idb = fakeIndexedDB();
  const sessionId = "peer-reconciled-retry";
  const root = { ...outboxEntry("peer-root", sessionId), state: "failed" };
  const copy = { ...root, id: "peer-copy", replaces: root.id };
  for (const entry of [root, copy]) idb.entries.set(entry.id, entry);
  const stale = loadWorker({ indexedDB: idb });
  const peer = loadWorker({ indexedDB: idb });
  const staleTab = stale.connectTab();
  const peerTab = peer.connectTab();
  await flush();
  peerTab.send({ op: "outbox_reconcile", n: 1, sessionId, confirmedIds: [copy.id] });
  await flush();
  assert.equal(idb.entries.size, 0);
  staleTab.received.length = 0;
  staleTab.send({ op: "outbox_reconcile", n: 2, sessionId, confirmedIds: [copy.id] });
  await flush();
  assert.deepEqual(staleTab.received.filter((message) => "outbox" in message).at(-1), { outbox: [] });
  assert.deepEqual(staleTab.received.at(-1), { outboxReconciled: 2 });
});

test("outbox: a lost acknowledgement retires browser-only lineage from an empty server tombstone", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const sessionId = "browser-only-retry";
  const root = {
    ...outboxEntry("browser-root", sessionId), message: "browser-only intent", uploads: ["root-file"],
    uploadProofs: { "root-file": "root-proof" }, state: "failed", error: "refused", enqueueOrder: 1,
  };
  const sibling = {
    ...outboxEntry("browser-sibling", sessionId), message: root.message, uploads: root.uploads, uploadProofs: root.uploadProofs,
    state: "failed", error: "refused", replaces: root.id, enqueueOrder: 2,
  };
  const differentIntent = { ...outboxEntry("different-intent-sibling", sessionId), message: "unrelated content", state: "failed", error: "refused", replaces: root.id, enqueueOrder: 3 };
  const differentUpload = {
    ...outboxEntry("different-upload-sibling", sessionId), message: root.message, uploads: ["other-file"], uploadProofs: { "other-file": "other-proof" },
    state: "failed", error: "refused", replaces: root.id, enqueueOrder: 4,
  };
  const sameTextUnrelated = { ...outboxEntry("same-text-unrelated", sessionId), message: root.message, state: "failed", error: "refused", enqueueOrder: 5 };
  for (const entry of [root, sibling, differentIntent, differentUpload, sameTextUnrelated]) idb.entries.set(entry.id, entry);

  const srv = agentServer();
  const worker = loadWorker({ indexedDB: idb, respond: srv.respond });
  const tab = worker.connectTab();
  await flush();

  tab.send({ op: "outbox_add", n: 1, entry: { ...outboxEntry("invalid-copy", sessionId), message: "not the original intent", replaces: root.id } });
  await flush();
  assert.deepEqual(srv.cmds().filter(({ command }) => command.type === "outbox_add"), [], "a same-session but different-intent replaces value is not trusted");
  assert.equal(idb.entries.has(root.id), true);
  assert.equal(idb.entries.has("invalid-copy"), false);

  tab.send({ op: "outbox_add", n: 2, entry: { ...outboxEntry("browser-copy", sessionId), message: root.message, uploads: root.uploads, uploadProofs: root.uploadProofs, replaces: root.id } });
  await flush();
  const [copy] = srv.cmds().filter(({ command }) => command.type === "outbox_add");
  assert.equal(copy.command.replaces, root.id);
  srv.reply(copy.rid, 0, null);
  await flush();
  assert.equal(idb.entries.has(root.id), true, "a lost response does not retire the local root");
  assert.equal(idb.entries.has(copy.command.id), true, "the committed copy stays for same-ID replay");
  t.mock.timers.tick(1_000);
  await flush();
  const retryPosts = srv.cmds().filter(({ command }) => command.type === "outbox_add");
  assert.deepEqual(retryPosts.map(({ command }) => command.id), [copy.command.id, copy.command.id]);
  srv.reply(retryPosts[1].rid, 200, { success: true, data: { entry: {
    id: copy.command.id, sessionId, mode: "prompt", message: "", state: "delivered", settlement: "none", createdAt: NOW,
  } } });
  await flush();
  assert.equal(srv.cmds().filter(({ command }) => command.type === "outbox_add").length, 2, "the accepted same-ID replay schedules no further POST");

  assert.deepEqual([...idb.entries.keys()].sort(), ["different-intent-sibling", "different-upload-sibling", "same-text-unrelated"]);
  const stored = outboxMessages(tab).filter((message) => "outboxStored" in message).at(-1).outboxStored;
  assert.equal(stored.message, "");
  assert.equal(stored.replaces, root.id, "the hook gets local lineage confirmation even though the server tombstone has no replaces field");
});
test("outbox: a refused retry copy stays linked to its root and acceptance retires only local siblings", async () => {
  const idb = fakeIndexedDB();
  const root = {
    ...outboxEntry("lineage-root"), state: "failed", error: "refused", enqueueOrder: 1,
    uploads: ["same-file"], uploadProofs: { "same-file": "same-proof" },
  };
  const sibling = {
    ...outboxEntry("lineage-sibling"), message: root.message, state: "failed", error: "refused", replaces: root.id, enqueueOrder: 2,
    uploads: root.uploads, uploadProofs: root.uploadProofs,
  };
  const unrelated = {
    ...outboxEntry("unrelated"), state: "failed", error: "refused", enqueueOrder: 3,
    uploads: ["unrelated-file"], uploadProofs: { "unrelated-file": "unrelated-proof" },
  };
  const otherSession = {
    ...outboxEntry("other-session", "b"), state: "failed", error: "refused", replaces: root.id, enqueueOrder: 4,
    uploads: ["other-file"], uploadProofs: { "other-file": "other-proof" },
  };
  for (const entry of [root, sibling, unrelated, otherSession]) idb.entries.set(entry.id, entry);
  const srv = agentServer();
  const worker = loadWorker({ indexedDB: idb, respond: srv.respond });
  const tab = worker.connectTab();
  await flush();

  tab.send({ op: "outbox_add", n: 1, entry: {
    ...outboxEntry("lineage-refused"), message: root.message, replaces: root.id, uploads: root.uploads, uploadProofs: root.uploadProofs,
  } });
  await flush();
  const first = srv.cmds().find(({ command }) => command.id === "lineage-refused");
  assert.equal(first.command.replaces, root.id);
  srv.reply(first.rid, 404, { code: "upload_missing", error: "The upload is gone" });
  await flush();
  assert.equal(idb.entries.get("lineage-refused").state, "failed");

  tab.send({ op: "outbox_add", n: 2, entry: {
    ...outboxEntry("lineage-retry"), message: root.message, replaces: "lineage-refused", uploads: root.uploads, uploadProofs: root.uploadProofs,
  } });
  await flush();
  const retry = srv.cmds().find(({ command }) => command.id === "lineage-retry");
  assert.equal(retry.command.replaces, root.id, "retrying the refused copy stays anchored to the server-known original");
  srv.reply(retry.rid, 200, { success: true, data: { entry: {
    ...outboxEntry(retry.command.id), message: root.message, state: "held", uploads: root.uploads, replaces: root.id,
  } } });
  await flush();

  assert.deepEqual([...idb.entries.keys()].sort(), ["other-session", "unrelated"]);
  assert.deepEqual(idb.entries.get("unrelated").uploadProofs, { "unrelated-file": "unrelated-proof" });
  assert.deepEqual(idb.entries.get("other-session").uploadProofs, { "other-file": "other-proof" });
});

test("outbox: a persisted retry chain is flattened before sending", async () => {
  const idb = fakeIndexedDB();
  const message = "persisted retry content";
  const root = { ...outboxEntry("persisted-root"), message, state: "failed", error: "refused", enqueueOrder: 1 };
  const refused = { ...outboxEntry("persisted-refused"), message, state: "failed", error: "refused", replaces: root.id, enqueueOrder: 2 };
  const copy = { ...outboxEntry("persisted-copy"), message, state: "sending", replaces: refused.id, enqueueOrder: 3 };
  for (const entry of [root, refused, copy]) idb.entries.set(entry.id, entry);
  const srv = agentServer();
  loadWorker({ indexedDB: idb, respond: srv.respond });
  await flush();

  const [cmd] = srv.cmds();
  assert.equal(cmd.command.id, copy.id);
  assert.equal(cmd.command.replaces, root.id);
  srv.reply(cmd.rid, 200, { success: true, data: { entry: { ...outboxEntry(copy.id), state: "held", replaces: root.id } } });
  await flush();
  assert.equal(idb.entries.size, 0);
});

test("outbox: a cyclic local retry chain is failed without sending", async () => {
  const idb = fakeIndexedDB();
  idb.entries.set("cycle-a", { ...outboxEntry("cycle-a"), state: "failed", replaces: "cycle-b" });
  idb.entries.set("cycle-b", { ...outboxEntry("cycle-b"), state: "sending", replaces: "cycle-a" });
  const srv = agentServer();
  loadWorker({ indexedDB: idb, respond: srv.respond });
  await flush();

  assert.deepEqual(srv.cmds(), []);
  assert.equal(idb.entries.get("cycle-b").state, "failed");
  assert.match(idb.entries.get("cycle-b").error, /retry chain is invalid/);
});

test("outbox: a missing retry ancestor remains the server anchor", async () => {
  const idb = fakeIndexedDB();
  const copy = { ...outboxEntry("missing-parent-copy"), state: "sending", replaces: "server-held-original" };
  idb.entries.set(copy.id, copy);
  const srv = agentServer();
  loadWorker({ indexedDB: idb, respond: srv.respond });
  await flush();

  const [cmd] = srv.cmds();
  assert.equal(cmd.command.replaces, "server-held-original");
  srv.reply(cmd.rid, 200, { success: true, data: { entry: { ...outboxEntry(copy.id), state: "held" } } });
  await flush();
  assert.equal(idb.entries.size, 0);
});
test("outbox: an accepted cross-session copy leaves its unconfirmed original intact", async () => {
  const idb = fakeIndexedDB();
  idb.entries.set("cross-session-original", { ...outboxEntry("cross-session-original", "a"), state: "failed" });
  const worker = loadWorker({
    indexedDB: idb,
    respond: (body) => ({ status: 200, body: { success: true, data: { entry: {
      id: body.id, sessionId: "b", mode: body.mode, message: body.message, state: "held", createdAt: NOW,
    } } } }),
  });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: { ...outboxEntry("cross-session-copy", "b"), replaces: "cross-session-original" } });
  await flush();

  assert.equal(idb.entries.has("cross-session-original"), true);
  assert.equal(idb.entries.has("cross-session-copy"), false);
  assert.equal(Object.hasOwn(tab.received.find((message) => "outboxStored" in message).outboxStored, "replaces"), false);
});

test("outbox: over SSE the worker POSTs outbox_add itself", async () => {
  const idb = fakeIndexedDB();
  const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 200, body: acceptedM1 }) });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1", "s/1") });
  await flush();
  assert.deepEqual(worker.requests, ["POST /api/agent/s%2F1"]);
  assert.deepEqual(worker.posts, [{ type: "outbox_add", id: "m1", scope: "test-scope", mode: "prompt", message: "hi m1" }]);
  assert.deepEqual(outboxMessages(tab).slice(-2), [{ outboxStored: acceptedM1.data.entry }, { outbox: [] }]);
  assert.equal(idb.entries.size, 0);
});

test("outbox: a 503 or no answer keeps it sending and retries after 1 s doubling; a wake sends it at once", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  let answer = () => ({ status: 503, body: { error: "down" } });
  const worker = loadWorker({ indexedDB: idb, respond: (body) => answer(body) });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  assert.equal(worker.posts.length, 1);
  answer = () => {
    throw new TypeError("Failed to fetch");
  };
  t.mock.timers.tick(999);
  await flush();
  assert.equal(worker.posts.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(worker.posts.length, 2, "again after 1 s");
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(worker.posts.length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(worker.posts.length, 3, "then after 2 s");
  assert.equal(idb.entries.get("m1").state, "sending");
  assert.deepEqual(outboxMessages(tab), [{ outbox: [{ ...outboxEntry("m1"), state: "sending", enqueueOrder: 1 }] }, { outboxAdded: 1 }], "a transient failure changes nothing a tab sees");

  answer = () => ({ status: 200, body: acceptedM1 });
  tab.send({ op: "wake", reason: "online", visible: true, clientId: "c" });
  await flush();
  assert.equal(worker.posts.length, 4, "the wake did not wait for the 4 s delay");
  assert.equal(idb.entries.size, 0);
});

test("outbox: a 413 or 404 is final: failed with the server's error and kept until a drop; the session's next entry goes", async () => {
  const idb = fakeIndexedDB();
  const refusals = { m1: { status: 413, body: { error: "Too large" } }, m2: { status: 404, body: {} } };
  const worker = loadWorker({ indexedDB: idb, respond: (body) => refusals[body.id] });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1", "a", NOW) });
  tab.send({ op: "outbox_add", n: 2, entry: outboxEntry("m2", "a", NOW + 1) });
  await flush();
  assert.deepEqual(worker.posts.map((post) => post.id), ["m1", "m2"], "oldest first");
  const failed1 = { ...outboxEntry("m1", "a", NOW), state: "failed", error: "Too large", enqueueOrder: 1 };
  const failed2 = { ...outboxEntry("m2", "a", NOW + 1), state: "failed", error: "HTTP 404", enqueueOrder: 2 };
  assert.deepEqual(idb.entries.get("m1"), failed1);
  assert.deepEqual(idb.entries.get("m2"), failed2);
  assert.deepEqual(tab.received.at(-1), { outbox: [failed1, failed2] });

  tab.send({ op: "wake", reason: "online", visible: true, clientId: "c" });
  tab.send({ op: "outbox_drop", n: 3, id: "m1" });
  await flush();
  assert.deepEqual([...idb.entries.values()], [failed2]);
  assert.deepEqual(tab.received.at(-1), { outbox: [failed2] });
  assert.equal(worker.posts.length, 2, "a failed entry is never sent again");
});

test("outbox: a new worker over the same IndexedDB resends what an earlier one left and tells an attaching tab", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const down = () => ({ status: 503, body: {} });
  const first = loadWorker({ indexedDB: idb, respond: down });
  first.connectTab().send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  assert.equal(idb.entries.get("m1").state, "sending");

  const second = loadWorker({ indexedDB: idb, respond: down });
  const tab = second.connectTab();
  await flush();
  assert.deepEqual(second.posts, [{ type: "outbox_add", id: "m1", scope: "test-scope", mode: "prompt", message: "hi m1" }]);
  assert.deepEqual(tab.received, [{ outbox: [{ ...outboxEntry("m1"), state: "sending", enqueueOrder: 1 }] }]);
});

test("outbox: an entry over 7 days old is never sent again: a new worker marks it failed", async () => {
  const idb = fakeIndexedDB();
  const old = { ...outboxEntry("m1", "a", Date.now() - 8 * 24 * 60 * 60 * 1000), state: "sending" };
  idb.entries.set("m1", old);
  const worker = loadWorker({ indexedDB: idb });
  const tab = worker.connectTab();
  await flush();
  const failed = { ...old, state: "failed", error: "Not sent within 7 days." };
  assert.deepEqual(worker.posts, [], "no outbox_add");
  assert.deepEqual(idb.entries.get("m1"), failed);
  assert.ok(tab.received.length > 0);
  for (const message of tab.received) assert.deepEqual(message, { outbox: [failed] }, "only ever shown as failed");
});

test("outbox: a failed commit rejects the add and retains no entry or transport command", async () => {
  const idb = fakeIndexedDB();
  const worker = loadWorker({ indexedDB: idb });
  const tab = worker.connectTab();
  await flush();
  idb.failWrites = true;
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  const ack = tab.received.find((message) => message.outboxAdded === 1);
  assert.equal(typeof ack?.error, "string");
  assert.equal(worker.posts.length, 0);
  assert.equal(idb.entries.size, 0);
  assert.equal(vm.runInContext("outboxItems.size", worker.context), 0);
});

test("outbox: unavailable IndexedDB rejects the add instead of claiming durable storage", async () => {
  const worker = loadWorker();
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  const ack = tab.received.find((message) => message.outboxAdded === 1);
  assert.equal(typeof ack?.error, "string");
  assert.equal(worker.posts.length, 0);
  assert.equal(vm.runInContext("outboxItems.size", worker.context), 0);
});

test("outbox: a failed initial read refuses new adds without overwriting stored entries", async () => {
  const idb = fakeIndexedDB();
  const existing = { ...outboxEntry("m1"), state: "sending" };
  idb.entries.set(existing.id, existing);
  idb.failReads = true;
  const worker = loadWorker({ indexedDB: idb });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: { ...outboxEntry("m1"), message: "replacement" } });
  await flush();
  const ack = tab.received.find((message) => message.outboxAdded === 1);
  assert.equal(typeof ack?.error, "string");
  assert.deepEqual([...idb.entries.values()], [existing]);
  assert.equal(worker.posts.length, 0);
});

test("outbox: later sends recover a failed initial read without restarting or overtaking stored input", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const existing = { ...outboxEntry("m1"), state: "sending" };
  idb.entries.set(existing.id, existing);
  idb.failReads = true;
  const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 503, body: {} }) });
  const first = worker.connectTab();
  const second = worker.connectTab();
  first.send({ op: "outbox_add", n: 1, entry: outboxEntry("m2") });
  await flush();
  assert.equal(typeof first.received.find((message) => message.outboxAdded === 1)?.error, "string");
  idb.failReads = false;
  first.send({ op: "outbox_add", n: 2, entry: outboxEntry("m2") });
  second.send({ op: "outbox_add", n: 3, entry: outboxEntry("m3") });
  await flush();
  assert.deepEqual(first.received.find((message) => message.outboxAdded === 2), { outboxAdded: 2 });
  assert.deepEqual(second.received.find((message) => message.outboxAdded === 3), { outboxAdded: 3 });
  assert.deepEqual(idb.entries.get("m1"), existing);
  assert.deepEqual([...idb.entries.keys()].sort(), ["m1", "m2", "m3"]);
  assert.deepEqual(worker.posts.map((post) => post.id), ["m1"], "recovery sends the retained head only once");
});

test("outbox: a later tab recovers stored failed messages and can delete them after an initial read failure", async () => {
  const idb = fakeIndexedDB();
  const existing = { ...outboxEntry("m1"), state: "failed", error: "refused" };
  idb.entries.set(existing.id, existing);
  idb.failReads = true;
  const worker = loadWorker({ indexedDB: idb });
  worker.connectTab();
  await flush();
  idb.failReads = false;
  const tab = worker.connectTab();
  await flush();
  assert.deepEqual(tab.received.filter((message) => "outbox" in message).at(-1), { outbox: [existing] });
  tab.send({ op: "outbox_drop", n: 4, id: "m1" });
  await flush();
  assert.deepEqual(tab.received.find((message) => message.outboxDropped === 4), { outboxDropped: 4 });
  assert.equal(idb.entries.has("m1"), false);
  assert.deepEqual(worker.posts, [], "deleting a failed held message never dispatches it");
});

test("outbox: a legacy stored entry without a scope fails without posting or binding to a new scope", async () => {
  const idb = fakeIndexedDB();
  const legacy = { ...outboxEntry("m1"), state: "sending" };
  delete legacy.scope;
  idb.entries.set(legacy.id, legacy);
  const worker = loadWorker({ indexedDB: idb });
  const tab = worker.connectTab();
  await flush();
  assert.deepEqual(worker.posts, []);
  const failed = idb.entries.get(legacy.id);
  assert.equal(failed.state, "failed");
  assert.equal(typeof failed.error, "string");
  assert.equal("scope" in failed, false);
  assert.deepEqual(tab.received.at(-1), { outbox: [failed] });
});

test("outbox: a scope-changed refusal is permanent and preserves the original scope and server reason", async () => {
  const idb = fakeIndexedDB();
  const worker = loadWorker({
    indexedDB: idb,
    respond: () => ({ status: 409, body: { code: "outbox_scope_changed", error: "The installation or sign-in changed." } }),
  });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  const failed = { ...outboxEntry("m1"), state: "failed", error: "The installation or sign-in changed.", enqueueOrder: 1 };
  assert.deepEqual(idb.entries.get("m1"), failed);
  assert.equal(worker.posts[0].scope, "test-scope");
  tab.send({ op: "wake", reason: "online", visible: true });
  await flush();
  assert.equal(worker.posts.length, 1);
  assert.deepEqual(tab.received.at(-1), { outbox: [failed] });
});

for (const stalled of ["headers", "body"]) test(`outbox: a POST stalled at ${stalled} times out, retries, and is accepted`, async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  let attempt = 0;
  let aborted = false;
  const held = { ...outboxEntry("m1"), state: "held" };
  const worker = loadWorker({
    indexedDB: idb,
    respond: (_body, init) => {
      if (++attempt > 1) return { status: 200, body: { success: true, data: { entry: held } } };
      const pending = new Promise((_, reject) => init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }));
      return stalled === "headers" ? pending : { status: 200, body: pending };
    },
  });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  const deadline = 40_000 + Math.ceil(JSON.stringify(worker.posts[0]).length / 2);
  t.mock.timers.tick(deadline - 1);
  await flush();
  assert.equal(aborted, false);
  assert.equal(idb.entries.get("m1").state, "sending");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(aborted, true);
  assert.equal(idb.entries.get("m1").state, "sending", "a partial 200 response is not acceptance");
  t.mock.timers.tick(999);
  await flush();
  assert.equal(attempt, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(attempt, 2);
  assert.equal(idb.entries.size, 0);
  assert.deepEqual(outboxMessages(tab).slice(-2), [{ outboxStored: held }, { outbox: [] }]);
});

test("outbox: a restarted worker sends a stored entry with a retired advisor field by plain HTTP POST", async () => {
  const idb = fakeIndexedDB();
  idb.entries.set("m1", { ...outboxEntry("m1", "s/1"), advisor: true, state: "sending" });
  const worker = loadWorker({ indexedDB: idb });
  await flush();
  assert.deepEqual(worker.requests, ["POST /api/agent/s%2F1"]);
});

test("outbox: already-running workers send the shared persisted session head before a later message", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const first = loadWorker({ indexedDB: idb, respond: () => ({ status: 503, body: {} }) });
  let available = false;
  const second = loadWorker({
    indexedDB: idb,
    respond: (body) => ({ status: available ? 200 : 503, body: { m1: acceptedM1, m2: acceptedM2 }[body.id] }),
  });
  const tabA = first.connectTab();
  const tabB = second.connectTab();
  await flush();
  tabA.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1", "a", NOW) });
  await flush();
  tabB.send({ op: "outbox_add", n: 1, entry: outboxEntry("m2", "a", NOW + 1) });
  await flush();
  assert.deepEqual(first.posts.map((post) => post.id), ["m1"]);
  assert.deepEqual(second.posts.map((post) => post.id), ["m1"], "M2 cannot overtake another worker's backed-off M1");
  assert.ok(idb.entries.has("m1") && idb.entries.has("m2"));

  available = true;
  tabB.send({ op: "wake", reason: "online", visible: true });
  await flush();
  assert.deepEqual(second.posts.map((post) => post.id), ["m1", "m1", "m2"]);
  assert.equal(idb.entries.size, 0);
  tabA.send({ op: "wake", reason: "online", visible: true });
  await flush();
  assert.deepEqual(first.posts.map((post) => post.id), ["m1"], "rows accepted by another worker are not replayed from private memory");
  assert.deepEqual(tabA.received.at(-1), { outbox: [] });
});

test("outbox: drop acknowledges only a committed deletion", async () => {
  const idb = fakeIndexedDB();
  const failed = { ...outboxEntry("m1"), state: "failed", error: "Not sent" };
  idb.entries.set("m1", failed);
  const worker = loadWorker({ indexedDB: idb });
  const tab = worker.connectTab();
  await flush();
  tab.received.length = 0;
  idb.hold = true;
  tab.send({ op: "outbox_drop", n: 7, id: "m1" });
  await flush();
  assert.deepEqual(tab.received, [], "no removal or acknowledgement before commit");
  assert.deepEqual(idb.entries.get("m1"), failed);
  assert.equal(vm.runInContext("outboxItems.size", worker.context), 1);
  idb.hold = false;
  idb.release();
  await flush();
  assert.equal(idb.entries.size, 0);
  assert.equal(vm.runInContext("outboxItems.size", worker.context), 0);
  assert.ok(tab.received.some((message) => message.outboxDropped === 7 && message.error === undefined));
  assert.deepEqual(tab.received.at(-1), { outbox: [] });
});

test("outbox: a failed delete rejects the drop while keeping its row, local entry, and displayed bubble", async () => {
  const idb = fakeIndexedDB();
  const failed = { ...outboxEntry("m1"), state: "failed", error: "Not sent" };
  idb.entries.set("m1", failed);
  const worker = loadWorker({ indexedDB: idb });
  const tab = worker.connectTab();
  await flush();
  tab.received.length = 0;
  idb.failWrites = true;
  tab.send({ op: "outbox_drop", n: 7, id: "m1" });
  await flush();
  const ack = tab.received.find((message) => message.outboxDropped === 7);
  assert.equal(typeof ack?.error, "string");
  assert.deepEqual(idb.entries.get("m1"), failed);
  assert.equal(vm.runInContext("outboxItems.size", worker.context), 1);
  assert.deepEqual(tab.received, [ack], "no list broadcast removes the failed bubble");
  assert.equal(worker.posts.length, 0);
});

test("outbox: add publishes the shared ordered list before its committed acknowledgement", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const down = () => ({ status: 503, body: {} });
  const first = loadWorker({ indexedDB: idb, respond: down });
  const second = loadWorker({ indexedDB: idb, respond: down });
  const tabA = first.connectTab();
  const tabB = second.connectTab();
  await flush();
  tabA.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1", "a", NOW) });
  await flush();
  tabB.received.length = 0;
  tabB.send({ op: "outbox_add", n: 2, entry: outboxEntry("m2", "a", NOW + 1) });
  await flush();
  const ackIndex = tabB.received.findIndex((message) => message.outboxAdded === 2);
  assert.ok(ackIndex > 0, "the complete list precedes the add acknowledgement");
  const lists = tabB.received.slice(0, ackIndex).filter((message) => "outbox" in message);
  assert.ok(lists.length > 0);
  for (const list of lists) assert.deepEqual(list.outbox.map((entry) => entry.id), ["m1", "m2"], "M2 is never published alone");
});

test("outbox: a backed-off session never blocks delivery to another session", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const worker = loadWorker({
    indexedDB: idb,
    respond: (body) => ({ status: body.id === "m1" ? 429 : 200, body: body.id === "m1" ? { code: "outbox_full" } : acceptedM2 }),
  });
  const tab = worker.connectTab();
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1", "offline", NOW) });
  await flush();
  tab.send({ op: "outbox_add", n: 2, entry: outboxEntry("m2", "online", NOW + 1) });
  await flush();
  assert.deepEqual(worker.posts.map((post) => post.id), ["m1", "m2"]);
  assert.deepEqual([...idb.entries.keys()], ["m1"]);
  assert.equal(idb.entries.get("m1").state, "sending");
});

test("outbox: a late refusal never brings back siblings another worker's 200 already deleted", async () => {
  const idb = fakeIndexedDB();
  const intent = "same failed retry intent";
  const root = { ...outboxEntry("root"), message: intent, state: "failed" };
  const sibling = { ...outboxEntry("sibling"), message: intent, state: "failed", replaces: root.id };
  const entry = { ...outboxEntry("m1"), message: intent, state: "sending", replaces: root.id };
  for (const saved of [root, sibling, entry]) idb.entries.set(saved.id, saved);
  let refuse;
  const first = loadWorker({ indexedDB: idb, respond: () => new Promise((resolve) => { refuse = resolve; }) });
  const tabA = first.connectTab();
  await flush();
  assert.deepEqual(first.posts.map((post) => post.id), ["m1"], "A's attempt is out");

  const accepted = { ...acceptedM1, data: { entry: { ...acceptedM1.data.entry, replaces: root.id } } };
  const second = loadWorker({ indexedDB: idb, respond: () => ({ status: 200, body: accepted }) });
  await flush();
  assert.equal(idb.entries.size, 0, "B's 200 deleted the copy, root and failed sibling");

  refuse({ status: 413, body: { error: "Too large" } });
  await flush();
  assert.equal(idb.entries.size, 0, "A's late failure is not written over the deletion");
  assert.equal(vm.runInContext("outboxItems.size", first.context), 0, "A forgets the removed lineage");
  assert.deepEqual(tabA.received.at(-1), { outbox: [] }, "A's tabs stop showing it");
  assert.equal(second.posts.length, 1);
});


test("outbox: an add whose commit succeeds stays accepted when the shared list cannot be read, and sends once reads work", async (t) => {
  t.mock.timers.enable(TIMERS);
  const idb = fakeIndexedDB();
  const worker = loadWorker({ indexedDB: idb, respond: () => ({ status: 200, body: acceptedM1 }) });
  const tab = worker.connectTab();
  await flush();
  idb.hold = true;
  tab.send({ op: "outbox_add", n: 1, entry: outboxEntry("m1") });
  await flush();
  idb.failReads = true;
  idb.hold = false;
  idb.release();
  await flush();
  const ack = tab.received.find((message) => message.outboxAdded === 1);
  assert.deepEqual(ack, { outboxAdded: 1 }, "committed: the composer may clear, so no duplicate under a fresh id");
  assert.deepEqual([...idb.entries.keys()], ["m1"]);
  const sending = { ...outboxEntry("m1"), state: "sending", enqueueOrder: 1 };
  assert.deepEqual(tab.received.filter((message) => "outbox" in message).at(-1), { outbox: [sending], partial: true }, "shown, but marked as a view that may miss earlier entries");
  assert.deepEqual(worker.posts, [], "no send before the shared head is known");

  idb.failReads = false;
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(worker.posts.map((post) => post.id), ["m1"], "the read is retried, then the head goes");
  const lists = tab.received.filter((message) => "outbox" in message);
  const partialAt = lists.findIndex((message) => message.partial === true);
  assert.ok(lists.slice(partialAt + 1).some((message) => message.partial === undefined && message.outbox.some((entry) => entry.id === "m1")), "a successful read publishes the complete list before the send");
  assert.equal(idb.entries.size, 0);
  assert.deepEqual(lists.at(-1), { outbox: [] });
});
