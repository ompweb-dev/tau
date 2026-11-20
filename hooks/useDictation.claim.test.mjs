import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

const { useDictation } = await import("../hooks/useDictation.ts");

// Isolated routes keep the server's scope, owner grace, and first-claim-token
// rules. The clock runs hook timers without real-time sleeps or a live server.
let world;
const overrides = [];
function override(target, key, value) {
  overrides.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function advance(ms) {
  const end = world.now + ms;
  for (;;) {
    const next = [...world.timers.entries()]
      .filter(([, timer]) => timer.at <= end)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) break;
    const [id, timer] = next;
    world.now = timer.at;
    if (timer.interval) timer.at += timer.interval;
    else world.timers.delete(id);
    await act(async () => {
      timer.callback();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
  }
  world.now = end;
  await flush();
}

class Recorder {
  constructor() {
    this.state = "inactive";
    this.mimeType = "audio/webm";
    world.recorders.push(this);
  }
  start() { this.state = "recording"; }
  requestData() { this.ondataavailable?.({ data: new Blob(["original recording"], { type: this.mimeType }) }); }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.requestData();
    this.onstop?.();
  }
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function jobView(job) {
  return { id: job.id, status: job.status, ...(job.error ? { error: job.error } : {}) };
}

function addJob(scope, { owner = "other-tab", status = "pending", text = "foreign words", after } = {}) {
  const id = `job-${++world.sequence}`;
  const job = { id, scope, owner, status, text, after, doneAt: world.now, claimedBy: null };
  world.jobs.set(id, job);
  return job;
}

function complete(job, text = "original words") {
  job.status = "done";
  job.text = text;
  job.error = undefined;
  job.doneAt = world.now;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  world = {
    now: 0, nextTimer: 0, timers: new Map(), sequence: 0, jobs: new Map(),
    uploads: [], claims: [], discards: [], retries: [], lists: [], polls: [],
    recorders: [], uploadGate: null, listFailure: null, retryFailure: null,
    claimFailures: 0, acknowledgements: [],
  };
  const schedule = (callback, ms = 0, interval = false) => {
    const id = ++world.nextTimer;
    world.timers.set(id, { callback, at: world.now + ms, interval: interval ? ms : 0 });
    return id;
  };
  override(window, "setTimeout", (callback, ms) => schedule(callback, ms));
  override(window, "clearTimeout", (id) => world.timers.delete(id));
  override(window, "setInterval", (callback, ms) => schedule(callback, ms, true));
  override(window, "clearInterval", (id) => world.timers.delete(id));
  override(navigator, "mediaDevices", { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) });
  override(window, "MediaRecorder", Recorder);
  override(globalThis, "MediaRecorder", Recorder);
  override(window, "AudioContext", undefined);
  override(document, "visibilityState", "visible");
  override(globalThis, "fetch", async (url, init = {}) => {
    const parsed = new URL(url, "https://omp.test");
    const method = init.method ?? "GET";
    if (parsed.pathname === "/api/stt" && method === "POST") {
      const body = init.body;
      const job = addJob(body.get("scope"), { owner: body.get("owner"), after: body.get("after") ?? undefined });
      world.uploads.push({ job, file: body.get("file") });
      const gate = world.uploadGate;
      if (gate) await gate.promise;
      world.acknowledgements.push(job.id);
      return response(202, { jobId: job.id });
    }
    if (parsed.pathname === "/api/stt") {
      const scope = parsed.searchParams.get("scope");
      world.lists.push(scope);
      if (world.listFailure) return response(world.listFailure, { error: "scope discovery unavailable" });
      return response(200, {
        jobs: [...world.jobs.values()].filter((job) => job.scope === scope && job.status !== "gone").reverse().map(jobView),
      });
    }
    const id = decodeURIComponent(parsed.pathname.slice("/api/stt/".length));
    const job = world.jobs.get(id);
    if (!job) return response(404, { error: "Transcription job not found" });
    if (method === "POST") {
      world.retries.push({ id, owner: parsed.searchParams.get("owner") });
      if (world.retryFailure) return response(world.retryFailure, { error: "retry unavailable" });
      if (job.status === "error") {
        job.status = "pending";
        job.error = undefined;
        job.owner = parsed.searchParams.get("owner");
      }
      return response(200, jobView(job));
    }
    if (method === "DELETE") {
      const claim = parsed.searchParams.get("claim");
      const owner = parsed.searchParams.get("owner");
      if (claim) {
        world.claims.push({ id, claim, owner });
        if (world.claimFailures-- > 0) throw new TypeError("temporary claim connection failure");
      } else world.discards.push(id);
      // Native closeSttJob returns an existing tombstone without changing its
      // claimed text/token, even for a token-less DELETE.
      if (job.status === "gone") {
        return response(200, claim && job.claimedBy === claim
          ? { ...jobView(job), status: "done", text: job.text, after: job.claimedAfter }
          : jobView(job));
      }
      if (!claim) {
        job.status = "gone";
        job.text = undefined;
        job.after = undefined;
        job.error = undefined;
        return response(200, jobView(job));
      }
      if (job.status !== "done" || (job.owner !== owner && world.now - job.doneAt < 15_000)) return response(200, jobView(job));
      job.claimedBy = claim;
      job.claimedAfter = job.owner === owner ? job.after : undefined;
      job.status = "gone";
      if (world.claimResponseLosses > 0) {
        world.claimResponseLosses--;
        throw new TypeError("claim accepted, but its response was lost");
      }
      return response(200, { id, status: "done", text: job.text, after: job.claimedAfter });
    }
    assert.equal(method, "GET");
    world.polls.push(id);
    return response(200, jobView(job));
  });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  while (overrides.length) {
    const { target, key, descriptor } = overrides.pop();
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  }
});

function mount(scope) {
  const transcripts = [];
  const errors = [];
  const view = renderHook(({ scope: currentScope }) => useDictation({
    scope: currentScope,
    onTranscript: (text, after) => transcripts.push({ scope: currentScope, text, after }),
    onError: (message) => errors.push(message),
  }), { initialProps: { scope } });
  return { view, transcripts, errors };
}

async function upload(view, after = "send") {
  await act(async () => { await view.result.current.start(); });
  await act(async () => { view.result.current.stop({ after }); });
  await flush();
  return world.uploads.at(-1).job;
}

test("claim transport retries keep one claim token, and a foreign owner still waits the server's 15-second grace", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view, "followup");
  original.view.unmount();
  sessionStorage.setItem("tau:stt-owner-token", "different-tab-owner");
  complete(job);
  const restored = mount("A");
  await flush();
  await advance(14_999);
  assert.deepEqual(restored.transcripts, []);
  assert.equal(job.status, "done");
  world.claimFailures = 1;
  await advance(1001);
  assert.deepEqual(restored.transcripts, [{ scope: "A", text: "original words", after: undefined }]);
  assert.equal(new Set(world.claims.map((entry) => entry.claim)).size, 1);
  assert.ok(world.claims.every((entry) => entry.owner === "different-tab-owner"));
  assert.equal(world.uploads.length, 1);
});


test("a committed claim whose response is lost repeats the same token and inserts only once", async () => {
  const original = mount("A");
  await flush();
  const job = await upload(original.view);
  original.view.unmount();
  complete(job);
  world.claimResponseLosses = 1;
  const restored = mount("A");
  await flush();
  await advance(500);
  assert.equal(job.status, "gone", "the first request really committed the server claim");
  assert.deepEqual(restored.transcripts, []);
  await advance(500);
  assert.deepEqual(restored.transcripts, [{ scope: "A", text: "original words", after: "send" }]);
  assert.equal(world.claims.length, 2);
  assert.equal(new Set(world.claims.map((entry) => entry.claim)).size, 1);
  assert.deepEqual(restored.errors, []);
  assert.equal(world.uploads.length, 1);
});

