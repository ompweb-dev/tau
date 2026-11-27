import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Real POST /api/notifications/answer with fake live wrappers: no pi spawn,
// no notification store writes beyond the throwaway agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "tau-answer-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { closeNotificationStore } = await import("./notification-store.ts");
after(() => {
  globalThis.__tauSessions = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  // The live wrapper publishes notifications, which opens the store in this dir;
  // Windows cannot delete a directory while that database is open.
  closeNotificationStore();
  rmSync(agentDir, { recursive: true, force: true });
});

const route = await import("../app/api/notifications/answer/route.ts");
const { WebRpcError } = await import("./rpc-manager.ts");
const hub = await import("./notification-hub.ts");
const notificationStore = await import("./notification-store.ts");
const { DEFAULT_NOTIFICATION_PREFS } = await import("./notification-events.ts");

const URL_ = "http://localhost/api/notifications/answer";
const post = (body, headers = {}) => route.POST(new Request(URL_, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));

function fakeSession({ alive = true, result = "answered", error = null } = {}) {
  const calls = [];
  return {
    calls,
    session: {
      isAlive: () => alive,
      answerExtensionUiRequest(id, response) {
        calls.push([id, response]);
        if (error) throw error;
        return result;
      },
    },
  };
}

test("a valid answer reaches the live wrapper exactly once", async () => {
  const { calls, session } = fakeSession();
  globalThis.__tauSessions = new Map([["local/s1", session]]);
  const response = await post({ sessionId: "s1", requestId: "req-1", response: { confirmed: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "answered" });
  assert.deepEqual(calls, [["req-1", { confirmed: true }]]);
});

test("all four response variants are accepted", async () => {
  const { calls, session } = fakeSession();
  globalThis.__tauSessions = new Map([["local/s1", session]]);
  for (const answer of [{ value: "main" }, { confirmed: false }, { cancelled: true }, { answers: [{ id: "q", selectedOptions: ["A"], customInput: "other" }] }]) {
    assert.equal((await post({ sessionId: "s1", requestId: "req", response: answer })).status, 200);
  }
  assert.deepEqual(calls.map(([, answer]) => answer), [
    { value: "main" }, { confirmed: false }, { cancelled: true }, { answers: [{ id: "q", selectedOptions: ["A"], customInput: "other" }] },
  ]);
});

test("alreadySettled and sessionGone are reported, not treated as errors", async () => {
  globalThis.__tauSessions = new Map([["local/s1", fakeSession({ result: "alreadySettled" }).session]]);
  const settled = await post({ sessionId: "s1", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await settled.json(), { status: "alreadySettled" });

  const dead = await post({ sessionId: "s2", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await dead.json(), { status: "sessionGone" });

  globalThis.__tauSessions = new Map([["local/s3", fakeSession({ alive: false }).session]]);
  const exited = await post({ sessionId: "s3", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await exited.json(), { status: "sessionGone" });
});

test("an answer reaches the wrapper under any key the registry holds for it", async () => {
  // registerSession keeps the old ids routable after pi moves the file, so
  // one registry entry under both keys is what the route sees.
  const { calls, session } = fakeSession();
  globalThis.__tauSessions = new Map([["local/s1", session], ["local/s0", session]]);
  const response = await post({ sessionId: "s0", requestId: "req-1", response: { value: "yes" } });
  assert.deepEqual(await response.json(), { status: "answered" });
  assert.deepEqual(calls, [["req-1", { value: "yes" }]]);
});

test("malformed requests are rejected before touching any session", async () => {
  const { calls, session } = fakeSession();
  globalThis.__tauSessions = new Map([["local/s1", session]]);
  const cases = [
    null,
    [],
    "text",
    { sessionId: "s1", requestId: "req" },
    { sessionId: "", requestId: "req", response: { value: "x" } },
    { sessionId: "s1", requestId: "r".repeat(257), response: { value: "x" } },
    { sessionId: "s1", requestId: "req", response: {} },
    { sessionId: "s1", requestId: "req", response: { value: 1 } },
    { sessionId: "s1", requestId: "req", response: { cancelled: false } },
    { sessionId: "s1", requestId: "req", response: { value: "x", confirmed: true } },
    { sessionId: "s1", requestId: "req", response: { answers: "yes" } },
    { sessionId: "s1", requestId: "req", response: { answers: [{ id: 1, selectedOptions: [] }] } },
  ];
  for (const body of cases) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "invalid_answer_request");
  }
  assert.deepEqual(calls, []);
});

test("invalid JSON and an oversized body get distinct statuses", async () => {
  assert.equal((await post("{not json")).status, 400);
  const huge = JSON.stringify({ sessionId: "s1", requestId: "req", response: { value: "x".repeat(70_000) } });
  const response = await post(huge, { "content-length": String(Buffer.byteLength(huge)) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "request_too_large");
});

test("a wrapper validation error becomes a 400 with its own code", async () => {
  const { session } = fakeSession({ error: new WebRpcError("Invalid ask dialog answers", "invalid_ask_answers") });
  globalThis.__tauSessions = new Map([["local/s1", session]]);
  const response = await post({ sessionId: "s1", requestId: "req", response: { value: "x" } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid ask dialog answers", code: "invalid_ask_answers" });
});

test("an answer that cannot be delivered is not reported as answered", async () => {
  // The wrapper's send() applies the offline/restarting gate; the route must
  // surface it instead of claiming the question was answered.
  for (const [error, status, body] of [
    [new WebRpcError("Laptop is offline. The run continues there; it reconnects automatically.", "host_offline", "refused"), 503, { hostOffline: true, delivery: "refused" }],
    [new WebRpcError("This session is restarting — retry in a moment.", "session_restarting"), 400, { code: "session_restarting" }],
  ]) {
    const { session } = fakeSession({ error });
    globalThis.__tauSessions = new Map([["local/s1", session]]);
    const response = await post({ sessionId: "s1", requestId: "req", response: { confirmed: true } });
    assert.equal(response.status, status, error.code);
    const payload = await response.json();
    assert.equal(payload.status, undefined, "a failed delivery is never answered");
    for (const [key, value] of Object.entries(body)) assert.equal(payload[key], value, `${error.code} ${key}`);
  }
});

// The real wrapper and the real route: this is the boundary the ask
// validation has to hold at, not a fake session that only echoes.
const { AgentSessionWrapper } = await import("./rpc-manager.ts");
const { localHost } = await import("./hosts/local-host.ts");

/** A live wrapper whose pi frames the test drives; `sent` collects what reached the child. */
function liveAskSession(t) {
  // Earlier tests left fake sessions in the registry; a running-change broadcast
  // walks it, and those fakes are not wrappers.
  globalThis.__tauSessions = new Map();
  let feed;
  const sent = [];
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
    onFrame(handler) { feed = handler; return () => {}; },
    sendCommand: async (command) => command.type === "get_state"
      ? { sessionId: "ask-live", sessionFile: "/tmp/ask-live.jsonl", isStreaming: false, isCompacting: false }
      : {},
    sendFrame(frame) { sent.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, "", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sent, emit: (frame) => feed(frame) };
}

test("the real wrapper refuses ask answers pi would reject, and keeps the question answerable", async (t) => {
  const { wrapper, sent, emit } = liveAskSession(t);
  await wrapper.waitUntilReady();
  globalThis.__tauSessions = new Map([["local/ask-live", wrapper]]);
  const ask = () => emit({
    type: "ui_request", id: 51, method: "askDialog",
    args: [[
      { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
      { id: "q2", question: "Pick many", multi: true, options: [{ label: "X" }, { label: "Y" }] },
    ]],
  });
  ask();
  const rejected = [
    [[], "answers:[] for a nonempty ask"],
    [[{ id: "q1", selectedOptions: ["A"] }], "one answer short"],
    [[{ id: "q1", selectedOptions: ["A"] }, { id: "q2", selectedOptions: [] }, { id: "q2", selectedOptions: [] }], "one answer too many"],
    [[{ id: "unknown", selectedOptions: ["A"] }, { id: "q2", selectedOptions: [] }], "unknown question id"],
    [[{ id: "q1", selectedOptions: ["nope"] }, { id: "q2", selectedOptions: [] }], "unknown option label"],
    [[{ id: "q1", selectedOptions: ["A", "B"] }, { id: "q2", selectedOptions: [] }], "two labels on a single-select question"],
  ];
  for (const [answers, why] of rejected) {
    const response = await post({ sessionId: "ask-live", requestId: "51", response: { answers } });
    assert.equal(response.status, 400, why);
    assert.equal((await response.json()).code, "invalid_ask_answers", why);
    assert.deepEqual(sent, [], `${why}: nothing reaches pi`);
    // Still answerable: the next request for it is not alreadySettled.
    const replay = [];
    wrapper.onEvent((event) => replay.push(event));
    assert.equal(replay[0]?.id, 51, `${why}: the dialog stays pending for reconnects`);
  }

  // The legitimate answers the same dialog accepts.
  for (const answers of [
    [{ id: "q1", selectedOptions: ["A"] }, { id: "q2", selectedOptions: ["X", "Y"] }],
    [{ id: "q1", selectedOptions: [], customInput: "typed" }, { id: "q2", selectedOptions: [] }],
  ]) {
    ask();
    const response = await post({ sessionId: "ask-live", requestId: "51", response: { answers } });
    assert.deepEqual(await response.json(), { status: "answered" }, JSON.stringify(answers));
    const forwarded = sent.at(-1);
    assert.equal(forwarded.type, "ui_response");
    assert.equal(forwarded.id, "51");
    assert.equal(forwarded.value.kind, "submit");
    assert.deepEqual(forwarded.value.results.map(({ id, selectedOptions, customInput }) => ({ id, selectedOptions, ...(customInput === undefined ? {} : { customInput }) })), answers);
  }

  // A cancel is always accepted, and a second answer is already settled.
  ask();
  assert.deepEqual(await (await post({ sessionId: "ask-live", requestId: "51", response: { cancelled: true } })).json(), { status: "answered" });
  assert.deepEqual(await (await post({ sessionId: "ask-live", requestId: "51", response: { cancelled: true } })).json(), { status: "alreadySettled" });
});

test("a dialog the notification omitted is not answerable from a notification", async (t) => {
  const { wrapper, sent, emit } = liveAskSession(t);
  await wrapper.waitUntilReady();
  globalThis.__tauSessions = new Map([["local/ask-live", wrapper]]);
  // The whole message must fit: clipping it would display only the harmless
  // prefix of an approval and leave it answerable.
  emit({
    type: "ui_request", id: 77, method: "confirm",
    args: ["Allow tool: bash", `${"A".repeat(480)} --delete-everything`],
  });

  const response = await post({ sessionId: "ask-live", requestId: "77", response: { confirmed: true } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "This dialog cannot be answered from a notification", code: "invalid_dialog_answer" });
  assert.deepEqual(sent, [], "no ui_response reaches pi for a dialog the notification never advertised");

  // The dialog is only unanswerable from the notification: the open session
  // still gets it replayed and can answer there.
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0]?.id, 77, "the dialog stays pending for the chat UI");
});

test("a server-owned confirm carries no partial approval into the notification", async (t) => {
  const { wrapper, sent } = liveAskSession(t);
  await wrapper.waitUntilReady();
  globalThis.__tauSessions = new Map([["local/ask-live", wrapper]]);
  notificationStore.saveDevice("srv-confirm-device", { ...DEFAULT_NOTIFICATION_PREFS, enabled: true });
  const events = [];
  const detach = hub.attachNotificationClient("srv-confirm-tab", (message) => {
    if (message.kind === "toast" || message.kind === "os") events.push(message.event);
  });
  t.after(detach);
  hub.reportPresence({ clientId: "srv-confirm-tab", deviceId: "srv-confirm-device", visible: false, sessionIds: [], seq: 1 });

  const controller = new AbortController();
  // From/to/delivery are rendered by the web dialog only; a notification that
  // carried just the message would still approve a decision the user cannot see
  // in full. confirmFromServer is the real path that raises this dialog.
  const pending = wrapper.confirmFromServer("Send a message to session prod?", {
    kind: "send_to_session",
    from: { id: "ask-live", name: "Source", hostId: "local", hostLabel: "This machine" },
    to: null,
    delivery: "steer",
    message: "rm -rf /srv/app",
  }, controller.signal);
  assert.equal(events.length, 1, "the confirm is published");
  const published = events[0];
  assert.ok(published.requestId?.startsWith("tau:"), published.requestId);
  assert.equal(published.dialog, undefined, "a partial approval is never advertised");

  const response = await post({ sessionId: "ask-live", requestId: published.requestId, response: { confirmed: true } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "This dialog cannot be answered from a notification", code: "invalid_dialog_answer" });
  assert.deepEqual(sent, [], "nothing reaches pi");
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0]?.id, published.requestId, "the web dialog stays pending for the full context");

  controller.abort();
  assert.equal(await pending, false);
});

test("an ask question without options answers with an empty options list", async (t) => {
  const { wrapper, sent, emit } = liveAskSession(t);
  await wrapper.waitUntilReady();
  globalThis.__tauSessions = new Map([["local/ask-live", wrapper]]);
  // A free-text question has no `options` key: the published dialog must still
  // answer instead of throwing on the missing array.
  emit({ type: "ui_request", id: 52, method: "askDialog", args: [[{ id: "q", question: "Free text?" }]] });

  const response = await post({
    sessionId: "ask-live", requestId: "52",
    response: { answers: [{ id: "q", selectedOptions: [], customInput: "typed" }] },
  });
  assert.deepEqual(await response.json(), { status: "answered" });
  const forwarded = sent.at(-1);
  assert.equal(forwarded.type, "ui_response");
  assert.deepEqual(forwarded.value.results[0].options, []);
});

test("a pi dialog, named by a UUID, is answered from the notification", async (t) => {
  const { wrapper, sent, emit } = liveAskSession(t);
  await wrapper.waitUntilReady();
  globalThis.__tauSessions = new Map([["local/ask-live", wrapper]]);
  const requestId = "6f0e3c1a-2b4d-4e5f-8a9b-0c1d2e3f4a5b";
  emit({ type: "ui_request", id: requestId, method: "confirm", args: ["Deploy?", ""] });
  const response = await post({ sessionId: "ask-live", requestId, response: { confirmed: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "answered" });
  assert.deepEqual(sent.at(-1), { type: "ui_response", id: requestId, value: true });
});
