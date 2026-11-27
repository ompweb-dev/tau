import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// sendAgentCommand over POST /api/agent/<id>. The shared worker is faked and keeps the transport samples the tab
// posts. HTTP goes to the `respond` fetch fake.
const samples = [];
const port = {
  onmessage: null,
  start() {},
  postMessage(message) {
    if (message.op === "metric") samples.push(message.sample);
  },
};
globalThis.SharedWorker = function SharedWorker() {
  return { port, onerror: null };
};

const requests = [];
let respond = () => ({ ok: true, status: 200, json: async () => ({ success: true, data: null }) });
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  return respond();
};

const { openEventStream } = await import("./event-stream.ts");
const { HostOfflineError, sendAgentCommand } = await import("./agent-client.ts");

// The tab's transport exists once any stream opened (AppShell's do at start).
openEventStream({ kind: "running" });

test("commands use fetch, and a fetch fake without headers works", async () => {
  requests.length = 0;
  respond = () => ({ ok: true, status: 200, json: async () => ({ success: true, data: 42 }) });
  assert.equal(await sendAgentCommand("s1", { type: "get_state" }), 42);
  respond = () => ({ ok: false, status: 503, json: async () => ({ error: "Host offline", hostOffline: true, delivery: "refused" }) });
  await assert.rejects(sendAgentCommand("s1", { type: "prompt", message: "hi" }), (error) => error instanceof HostOfflineError && error.mayHaveRun === false);
  assert.deepEqual(requests.map(({ url }) => url), ["/api/agent/s1", "/api/agent/s1"]);
});

const pick = (sample, keys) => Object.fromEntries(keys.map((key) => [key, sample[key]]));
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A fetch fake whose responses the test releases: `release(i, response)` answers the i-th request. */
function heldFetch() {
  const held = [];
  respond = () => new Promise((resolve) => held.push(resolve));
  return (index, response) => held[index](response);
}
const answered = (headers = {}) => ({ ok: true, status: 200, headers: new Headers(headers), json: async () => ({ success: true, data: null }) });

test("an HTTP action sample uses the timing headers and splits in-flight POSTs by session", async () => {
  const release = heldFetch();
  const prompt = { type: "prompt", message: "first" };
  const other = { type: "prompt", message: "other session" };
  const pending = [sendAgentCommand("s1", prompt), sendAgentCommand("s2", other)];
  samples.length = 0;
  const before = Date.now();
  const third = sendAgentCommand("s1", { type: "abort" });
  await settle();
  release(2, answered({ "x-tau-received-at": "5", "x-tau-replied-at": "6" }));
  await third;
  const [sample] = samples;
  assert.equal(samples.length, 1);
  assert.deepEqual(
    pick(sample, ["metric", "type", "session", "via", "socket", "status", "outcome", "bytes", "behindBytes", "behindSameBytes", "behindOtherBytes", "replyBehindOtherBytes", "recvAt", "repliedAt"]),
    {
      metric: "action", type: "abort", session: "s1", via: "http", socket: "http", status: 200, outcome: "ok", bytes: 16,
      behindBytes: JSON.stringify(prompt).length, behindSameBytes: JSON.stringify(prompt).length, behindOtherBytes: JSON.stringify(other).length, replyBehindOtherBytes: null, recvAt: 5, repliedAt: 6,
    },
  );
  assert.match(sample.req, /^[a-z0-9]{8,64}$/);
  assert.ok(sample.sentAt >= before && sample.gotAt >= sample.sentAt);
  release(0, answered());
  release(1, answered());
  await Promise.all(pending);

  respond = () => Promise.reject(new TypeError("Failed to fetch"));
  await assert.rejects(sendAgentCommand("s1", { type: "get_state" }), TypeError);
  assert.deepEqual(pick(samples.at(-1), ["metric", "type", "via", "socket", "status", "outcome"]), { metric: "action", type: "get_state", via: "http", socket: "http", status: 0, outcome: "error" });
});

test("an HTTP command slower than the ack formula records one hang, then its action", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const release = heldFetch();
  const command = { type: "compact", customInstructions: "x".repeat(3_170) };
  const bytes = JSON.stringify(command).length;
  samples.length = 0;
  const pending = sendAgentCommand("s1", command);
  await settle();
  t.mock.timers.tick(10_000 + Math.ceil(bytes / 32) - 1);
  assert.deepEqual(samples, []);
  t.mock.timers.tick(1);
  t.mock.timers.tick(60_000);
  assert.deepEqual(samples.map((sample) => pick(sample, ["metric", "socket", "type", "via", "bytes", "waitedMs"])), [
    { metric: "hang", socket: "http", type: "compact", via: "http", bytes, waitedMs: 10_000 + Math.ceil(bytes / 32) },
  ]);
  release(0, answered());
  await pending;
  assert.deepEqual(samples.map((sample) => sample.metric), ["hang", "action"], "the fetch was not aborted");
  assert.equal(samples[0].req, samples[1].req);
});

test("outbox scope is learned before first enqueue, then remains available offline until hydration replaces it", async () => {
  const { getOutboxScope, rememberOutboxScope } = await import("./agent-client.ts");
  localStorage.removeItem("tau:outbox-scope");
  respond = () => ({ ok: false, status: 503, json: async () => ({ error: "Offline" }) });
  await assert.rejects(getOutboxScope("s1"), /Offline/);
  respond = () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { scope: "installation-a" } }) });
  assert.equal(await getOutboxScope("s1"), "installation-a");
  assert.equal(JSON.parse(requests.at(-1).init.body).type, "outbox_scope");
  const requestCount = requests.length;
  respond = () => { throw new Error("Offline"); };
  assert.equal(await getOutboxScope("s1"), "installation-a");
  assert.equal(requests.length, requestCount, "offline enqueue reuses its already-known scope");
  rememberOutboxScope("installation-b");
  assert.equal(await getOutboxScope("s1"), "installation-b", "new hydration only scopes new entries");
  localStorage.removeItem("tau:outbox-scope");
});
