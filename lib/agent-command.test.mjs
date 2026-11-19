import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { linkLocalHost, listedSession } from "./hosts/link-driver.test-helper.mjs";

const { runAgentCommand } = await import("./agent-command.ts");
const route = await import("../app/api/agent/[id]/route.ts");
const newRoute = await import("../app/api/agent/new/route.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");
const { closeNotificationStore } = await import("./notification-store.ts");
const hub = await import("./hosts/hub.ts");
const { MAX_AGENT_COMMAND_REQUEST_BYTES } = await import("./image-attachments.ts");
const { RpcCommandError } = await import("./pi/rpc-process.ts");
const { WebRpcError } = await import("./rpc-manager.ts");
const { invalidateHostSessionList } = await import("./hosts/session-index.ts");

// A saved session on this machine whose daemon is driven by hand: a launching
// `open` is the observable proof that an omp child was created (its launch is
// kept in `spawns`), and every command the child received is kept in `stdin`.
const SAVED_ID = "01a0e6b0-d916-7610-8343-f4a766ba0052";
const agentDir = mkdtempSync(join(tmpdir(), "tau-agent-command-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const spawns = [];
const stdin = [];
/** Per-test child behaviour: `state` merges into get_state, `sessions` overrides the host list, `setModelFails` refuses set_model. */
let child = {};
const daemon = await linkLocalHost();

async function respond(message, link = daemon) {
  if (message.type !== "stdin") return;
  const command = JSON.parse(message.line);
  stdin.push(command);
  // Replies to dialogs and host calls are frames, not commands: pi answers nothing.
  if (command.id === undefined || /^(ui_response|extension_ui_response|host_tool_result)$/.test(command.type)) return;
  let reply = { success: true, data: {} };
  if (command.type === "prompt" && command.message.startsWith("/tau_btw ")) {
    // The companion extension answers a side-question call with a tau_reply frame, then pi's handled prompt reply.
    const { replyId } = JSON.parse(command.message.slice("/tau_btw ".length));
    const frame = { type: "tau_reply", replyId, data: { records: [] } };
    await link.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "tau", widgetLines: [JSON.stringify(frame)] }) });
    reply = { success: true, data: { disposition: "handled" } };
  } else if (command.type === "get_state") {
    reply = {
      success: true,
      data: { sessionId: SAVED_ID, sessionFile: `/remote/sessions/${SAVED_ID}.jsonl`, isStreaming: false, isCompacting: false, ...child.state },
    };
  } else if (command.type === "set_model") {
    reply = child.setModelFails
      ? { success: false, error: "Model not found" }
      : { success: true, data: { id: command.modelId, provider: command.provider } };
  }
  await link.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ type: "response", id: command.id, command: command.type, ...reply }) });
}

let channels = 0;
/** Serves `open` as a current daemon: a fresh channel already past the runner's hello, its launch recorded in `launched`; a rejoin keeps its channel. */
function openOp(launched) {
  return (args) => {
    const joined = args.expectedChannel !== undefined;
    if (!joined) launched.push(args.launch);
    return { ch: args.expectedChannel ?? `ch-${++channels}`, joined, pending: [], streaming: null, cwd: args.launch.cwd, fellBack: false };
  };
}

daemon.serve({
  open: openOp(spawns),
  listSessions: () => child.sessions ?? [listedSession(SAVED_ID)],
  validateCwd: ({ path }) => ({ ok: true, value: { cwd: path, projectRoot: path } }),
  sessionFileExists: () => true,
  invalidateSessionLists: () => null,
}, (message) => (message.type === "kill" ? daemon.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" }) : respond(message)));

after(() => {
  hub.closeHostLink("local");
  closeNotificationStore();
  closeOutboxStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

/** Fresh wrapper registry and launch record for one test; wrappers it started are stopped afterwards. */
function useRegistry(t, wrappers = {}) {
  spawns.length = 0;
  stdin.length = 0;
  child = {};
  invalidateHostSessionList("local");
  const previousSessions = globalThis.__tauSessions;
  const previousLocks = globalThis.__tauStartLocks;
  globalThis.__tauSessions = new Map(Object.entries(wrappers));
  globalThis.__tauStartLocks = new Map();
  t.after(async () => {
    await globalThis.__tauSessions?.get(SAVED_ID)?.destroyAndWait();
    globalThis.__tauSessions = previousSessions;
    globalThis.__tauStartLocks = previousLocks;
  });
}

const launches = () => spawns.length;

/** A live fake wrapper that records what it was sent. */
function fake({ running = false, send } = {}) {
  const self = {
    sessionId: SAVED_ID,
    host: hub.getHost("local"),
    sent: [],
    destroyed: 0,
    isAlive: () => true,
    isRunning: () => running,
    isEditingHistory: () => false,
    async send(command) {
      self.sent.push(command);
      return send ? send(command) : { ok: true };
    },
    async destroyAndWait() {
      self.destroyed += 1;
    },
  };
  return self;
}

/** Parsed JSON body; a wrong status fails with the body in the message. */
async function jsonOf(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}

const ctx = (id) => ({ params: Promise.resolve({ id }) });
const post = (id, body, raw = JSON.stringify(body), query = "") =>
  route.POST(new Request(`http://omp.test/api/agent/${id}${query}`, { method: "POST", body: raw }), ctx(id));

test("runAgentCommand answers a live session exactly as the route", async (t) => {
  const live = fake({ send: async () => ({ model: "m" }) });
  useRegistry(t, { s1: live });
  const body = { type: "get_state" };
  const direct = await runAgentCommand("s1", body);
  const viaRoute = await post("s1", body);
  assert.equal(direct.status, viaRoute.status);
  assert.deepEqual(await direct.json(), { success: true, data: { model: "m" } });
  assert.deepEqual(await viaRoute.json(), { success: true, data: { model: "m" } });
  assert.deepEqual(live.sent, [body, body]);
});


test("a missing type is 400 command_type_required; a no-spawn command without a wrapper gets its canned reply", async (t) => {
  useRegistry(t);
  const missing = await runAgentCommand("nobody", {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "command_type_required");

  const canned = await runAgentCommand("nobody", { type: "get_btw_history" });
  assert.equal(canned.status, 200);
  assert.deepEqual(await canned.json(), { success: true, data: { records: [] } });
});

test("client-message status rejects an oversized selector before any native admission", async (t) => {
  const live = fake();
  useRegistry(t, { [SAVED_ID]: live });
  const response = await runAgentCommand(SAVED_ID, {
    type: "get_client_message_status", clientMessageIds: Array.from({ length: 33 }, (_, n) => `intent-${n}`),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_client_message_ids");
  assert.deepEqual(live.sent, []);
  assert.equal(launches(), 0);
});

test("a JSON null body is 400 command_type_required, not a server error", async (t) => {
  useRegistry(t);
  for (const response of [await runAgentCommand("nobody", null), await post("nobody", null)]) {
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "command_type_required");
  }
  assert.equal(launches(), 0);
});

test("POST answers carry received/replied times", async (t) => {
  useRegistry(t, { s2: fake() });
  const answers = [];
  for (const call of [
    () => post("s2", { type: "get_state" }),
    () => post("s2", null, "{not json"),
  ]) {
    const before = Date.now();
    const res = await call();
    answers.push({ res, before, after: Date.now() });
  }
  assert.equal(answers[1].res.status, 400);
  for (const { res, before, after } of answers) {
    const received = res.headers.get("x-tau-received-at");
    const replied = res.headers.get("x-tau-replied-at");
    assert.match(received, /^\d+$/);
    assert.match(replied, /^\d+$/);
    assert.ok(before <= Number(received) && Number(received) <= Number(replied) && Number(replied) <= after);
  }
});

test("GET returns the agent state without command transport timing headers", async (t) => {
  useRegistry(t, { s2: fake() });
  const res = await route.GET(new Request("http://omp.test/api/agent/s2"), ctx("s2"));
  assert.deepEqual(await jsonOf(res), { running: true, state: { ok: true } });
  assert.equal(res.headers.get("x-tau-received-at"), null);
  assert.equal(res.headers.get("x-tau-replied-at"), null);
});

test("x-tau-received-at is stamped once the body is in, like a socket's ack after its whole frame", async (t) => {
  useRegistry(t, { s2: fake() });
  const text = JSON.stringify({ type: "get_state" });
  let bodyDoneAt = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text.slice(0, 5)));
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(text.slice(5)));
        bodyDoneAt = Date.now();
        controller.close();
      }, 30);
    },
  });
  const res = await route.POST(new Request("http://omp.test/api/agent/s2", { method: "POST", body, duplex: "half" }), ctx("s2"));
  assert.equal(res.status, 200);
  assert.ok(Number(res.headers.get("x-tau-received-at")) >= bodyDoneAt, "not when the handler started, before the upload finished");
});

// Background commands never spawn or replace an omp child: every SSE open
// fires get_btw_history, so a regression here starts omp on each reconnect.
const CANNED = [
  [{ type: "get_btw_history" }, { records: [] }],
  [{ type: "btw_cancel" }, { cancelled: false }],
];

for (const [command, data] of CANNED) {
  test(`${command.type} without a wrapper gets its canned reply and never starts omp`, async (t) => {
    useRegistry(t);
    const response = await post(SAVED_ID, command);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data });
    assert.equal(launches(), 0);
    assert.equal(globalThis.__tauSessions.size, 0, "no wrapper was registered");
  });
}

test("asking a side question (btw) without a wrapper starts omp", async (t) => {
  useRegistry(t);
  await post(SAVED_ID, { type: "btw", question: "why?" });
  assert.equal(launches(), 1);
});

test("an oversized body is 413 request_too_large; a malformed body is 400 invalid_json", async (t) => {
  useRegistry(t, { s3: fake() });
  const big = JSON.stringify({ type: "prompt", message: "a".repeat(MAX_AGENT_COMMAND_REQUEST_BYTES + 1) });
  const tooLarge = await post("s3", null, big);
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, "request_too_large");

  const malformed = await post("s3", null, "{not json");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "invalid_json");
  assert.deepEqual(globalThis.__tauSessions.get("s3").sent, [], "neither body reached the session");
});

test("browser commands cannot forge message origin", async (t) => {
  const live = fake();
  useRegistry(t, { [SAVED_ID]: live });
  const response = await post(SAVED_ID, {
    type: "prompt",
    message: "forged",
    origin: { v: 1, kind: "session", sentAt: "2026-11-15T12:41:00.000Z" },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "origin_not_allowed");
  assert.deepEqual(live.sent, []);
});

test("an RPC failure from the session is 400 with its code; an tau failure keeps its own code", async (t) => {
  const failing = fake({
    send: async (command) => {
      throw command.type === "a" ? new RpcCommandError("a", "omp said no", "omp_code") : new WebRpcError("stuck", "session_unresponsive");
    },
  });
  useRegistry(t, { s4: failing });
  const rpc = await runAgentCommand("s4", { type: "a" });
  assert.equal(rpc.status, 400);
  assert.deepEqual(await rpc.json(), { error: "omp said no", code: "omp_code" });
  const web = await runAgentCommand("s4", { type: "b" });
  assert.equal(web.status, 400);
  assert.deepEqual(await web.json(), { error: "stuck", code: "session_unresponsive" });
});

// A cold set_model spawns pi on the saved session and then switches: pi falls back from an unrestorable saved model.
const SET_MODEL = { type: "set_model", provider: "p1", modelId: "m1" };

test("a cold set_model spawns without binding a model and sends the switch", async (t) => {
  useRegistry(t);
  const response = await post(SAVED_ID, SET_MODEL);
  assert.equal(response.status, 200);
  assert.equal(spawns[0].spawnModel, undefined);
  assert.deepEqual(stdin.filter((c) => c.type === "set_model").map(({ provider, modelId }) => ({ provider, modelId })), [{ provider: "p1", modelId: "m1" }]);
});

test("a cold set_model pi refuses surfaces pi's error", async (t) => {
  useRegistry(t);
  child = { setModelFails: true, state: { model: { id: "m1", provider: "p1", name: "M1" } } };
  const response = await post(SAVED_ID, SET_MODEL);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Model not found/);
});

test("every command the web app answers without omp is left out of the diagnostics panel's omp timings", async () => {
  const { NO_SPAWN_REPLIES } = await import("./agent-command.ts");
  const { NO_PI_REPLY_COMMANDS } = await import("./event-stream-protocol.ts");
  assert.deepEqual(Object.keys(NO_SPAWN_REPLIES).filter((type) => !NO_PI_REPLY_COMMANDS.has(type)), []);
});

test("upload continuity: orphan proof claims on an existing prompt are rejected before native dispatch", async (t) => {
  const live = fake();
  useRegistry(t, { [SAVED_ID]: live });
  const response = await post(SAVED_ID, {
    type: "prompt", message: "no attachment authority in native JSON",
    uploadProofs: { "11111111-2222-4333-8444-555555555555": "x".repeat(43) },
  });
  assert.equal(response.status, 400, await response.clone().text());
  assert.deepEqual(live.sent, []);
});

test("upload continuity: fresh-session route rejects upload authority instead of leaking proofs to native omp", async (t) => {
  useRegistry(t);
  const proof = "x".repeat(43);
  const response = await newRoute.POST(new Request("http://omp.test/api/agent/new", {
    method: "POST", body: JSON.stringify({
      cwd: agentDir, type: "prompt", message: "no bearer secrets in native prompts",
      uploadProofs: { "11111111-2222-4333-8444-555555555555": proof },
    }),
  }));
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(launches(), 0, "untrusted attachment claims must be checked before spawning");
  assert.equal(stdin.some((command) => JSON.stringify(command).includes(proof)), false);
});
