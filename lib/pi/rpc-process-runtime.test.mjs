import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

const { RpcProcess, RpcCommandError, RpcCommandTimeoutError, resolveTauExtensionPath } = await import("./rpc-process.ts");
const { AgentSessionWrapper } = await import("../rpc-manager.ts");

const onlineHost = {
  id: "local",
  label: "This machine",
  sessionOps: {},
  status: () => "online",
  onStatus: () => () => {},
  spawnRpc: async () => { throw new Error("this test never spawns"); },
  sessionFileExists: async () => false,
  invalidateSessionLists() {},
};

const READY_STATE = { sessionId: "s1", sessionFile: "/s/s1.jsonl", isStreaming: false };

/** A fake `pi --mode rpc` child: answers the initial `__tau_ready__` `get_state` probe and records each command. */
function makeTransport(autoReady = true) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4321,
    kill() {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  const lines = [];
  const spawnCalls = [];
  let partial = "";
  let onLine = () => {};
  stdin.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    const split = partial.split("\n");
    partial = split.pop();
    for (const line of split) {
      if (!line) continue;
      const frame = JSON.parse(line);
      if (autoReady && frame.id === "__tau_ready__" && frame.type === "get_state") {
        stdout.write(`${JSON.stringify({ id: "__tau_ready__", type: "response", command: "get_state", success: true, data: READY_STATE })}\n`);
        continue;
      }
      lines.push(frame);
      onLine(frame);
    }
  });
  stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));

  return {
    lines,
    get commands() { return lines.filter((frame) => frame.id !== undefined && frame.type !== "extension_ui_response"); },
    spawnCalls,
    child,
    set onLine(callback) { onLine = callback; },
    send(frame) { stdout.write(`${JSON.stringify(frame)}\n`); },
    spawn(...args) { spawnCalls.push(args); return child; },
  };
}

function startProcess(transport) {
  return new RpcProcess({
    cwd: "/w",
    dependencies: { resolvePiBin: () => "fake-pi", spawn: transport.spawn },
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  while (!predicate()) await tick();
}

test("pi never starts without tau's extension, which would send /tau_* calls (API keys included) to the model", () => {
  const transport = makeTransport();
  const previous = process.env.TAU_NO_EXTENSION;
  delete process.env.TAU_NO_EXTENSION;
  try {
    assert.throws(() => new RpcProcess({ cwd: "/w", dependencies: { resolvePiBin: () => "fake-pi", resolveTauExtensionPath: () => null, spawn: transport.spawn } }),
      /extension .* is missing/);
    assert.equal(transport.spawnCalls.length, 0);
  } finally {
    if (previous !== undefined) process.env.TAU_NO_EXTENSION = previous;
  }
});

test("with TAU_NO_EXTENSION=1 every extension call is refused instead of reaching pi as a prompt", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const previous = process.env.TAU_NO_EXTENSION;
  process.env.TAU_NO_EXTENSION = "1";
  try {
    await assert.rejects(proc.callExtension("tau_btw", { action: "history" }), /needs tau's pi extension/);
    assert.equal(transport.commands.filter((command) => command.type === "prompt").length, 0);
  } finally {
    if (previous === undefined) delete process.env.TAU_NO_EXTENSION;
    else process.env.TAU_NO_EXTENSION = previous;
    await proc.dispose();
  }
});

test("RpcProcess spawns --mode rpc with tau-extension, is ready on get_state, and correlates out-of-order responses", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  const ext = resolveTauExtensionPath();
  assert.deepEqual(transport.spawnCalls[0][1], ["--mode", "rpc", ...(ext ? ["--extension", ext] : [])]);
  const ready = await proc.waitReady();
  assert.deepEqual(ready, { type: "ready", ...READY_STATE });

  const replies = [];
  const first = proc.sendCommand({ type: "set_model", provider: "p", modelId: "m" }, undefined, (success, id) => replies.push([success, id]));
  const second = proc.sendCommand({ type: "get_state" });
  await until(() => transport.commands.length === 2);
  const [firstCommand, secondCommand] = transport.commands;
  assert.deepEqual(firstCommand, { id: firstCommand.id, type: "set_model", provider: "p", modelId: "m" });
  assert.equal(typeof firstCommand.id, "string");
  transport.send({ id: secondCommand.id, type: "response", command: "get_state", success: true, data: "second" });
  transport.send({ id: firstCommand.id, type: "response", command: "set_model", success: true, data: "first" });

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(replies, [[true, String(firstCommand.id)]]);
  await proc.dispose(0);
});

test("agent_settled reaches listeners as session_settled; get_state gains the queue and settlement pi does not report", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame.type));
  const state = async (data) => {
    const sent = transport.commands.length;
    const reply = proc.sendCommand({ type: "get_state" });
    await until(() => transport.commands.length > sent);
    const { id } = transport.commands.at(-1);
    transport.send({ id, type: "response", command: "get_state", success: true, data });
    return reply;
  };
  const idle = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  assert.deepEqual(await state(idle), { ...idle, queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] }, isSettled: true });
  transport.send({ type: "agent_start" });
  transport.send({ type: "queue_update", steering: ["s"], followUp: ["f"] });
  transport.send({ type: "agent_end" });
  const busy = { isStreaming: false, isCompacting: false, pendingMessageCount: 2 };
  assert.deepEqual(await state(busy), { ...busy, queuedMessageCount: 2, queuedMessages: { steering: ["s"], followUp: ["f"] }, isSettled: false });
  transport.send({ type: "queue_update", steering: [], followUp: [] });
  transport.send({ type: "agent_settled" });
  assert.equal((await state(idle)).isSettled, true);
  assert.deepEqual(frames, ["agent_start", "queue_update", "agent_end", "queue_update", "session_settled"]);
  await proc.dispose(0);
});

test("stdout splits frames at LF only: U+2028 inside a string and a character split across chunks stay one frame", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const notices = [];
  proc.onFrame((frame) => { if (frame.type === "notice") notices.push(frame.message); });
  const bytes = Buffer.from(`${JSON.stringify({ type: "notice", message: "a\u2028b\u2029c é" })}\r\n`, "utf8");
  const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1; // inside the two-byte é
  transport.child.stdout.write(bytes.subarray(0, cut));
  await tick();
  transport.child.stdout.write(bytes.subarray(cut));
  await until(() => notices.length > 0);
  assert.deepEqual(notices, ["a\u2028b\u2029c é"]);
  await proc.dispose(0);
});

test("callExtension sends /<command> <json> and settles on its tau_reply frame, which listeners never see", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame.type));
  const widget = (frame) => transport.send({ type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "tau", widgetLines: [JSON.stringify(frame)] });
  const call = proc.callExtension("tau_btw", { action: "history" });
  await until(() => transport.commands.length > 0);
  const [prompt] = transport.commands;
  assert.equal(prompt.type, "prompt");
  const sent = JSON.parse(prompt.message.slice("/tau_btw ".length));
  assert.equal(sent.action, "history");
  widget({ type: "tau_reply", replyId: "another server's call", data: { records: ["wrong"] } });
  widget({ type: "btw_record", record: { id: "r" } });
  widget({ type: "tau_reply", replyId: sent.replyId, data: { records: [] } });
  transport.send({ id: prompt.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
  assert.deepEqual(await call, { records: [] });
  assert.deepEqual(frames, ["btw_record"], "replies are consumed; other frames pass");

  const failing = proc.callExtension("tau_btw", { action: "ask" });
  await until(() => transport.commands.length > 1);
  const second = JSON.parse(transport.commands[1].message.slice("/tau_btw ".length));
  widget({ type: "tau_reply", replyId: second.replyId, error: "No model is selected for this session" });
  await assert.rejects(failing, (error) => error instanceof RpcCommandError && error.message === "No model is selected for this session");

  const orphan = proc.callExtension("tau_btw", { action: "history" });
  await until(() => transport.commands.length > 2);
  await proc.dispose(0);
  await assert.rejects(orphan, /exited/);
});

test("the companion extension's names reach user messages, queue snapshots and get_state", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  const tau = (frame) => transport.send({ type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "tau", widgetLines: [JSON.stringify(frame)] });
  const state = async () => {
    const sent = transport.commands.length;
    const reply = proc.sendCommand({ type: "get_state" });
    await until(() => transport.commands.length > sent);
    transport.send({ id: transport.commands.at(-1).id, type: "response", command: "get_state", success: true, data: { isStreaming: true, pendingMessageCount: 1 } });
    return reply;
  };
  assert.equal((await state()).supportsClientMessageIds, undefined, "no names before the extension speaks");
  tau({ type: "tau_hello" });
  await until(() => proc.tauExtension);
  const origin = { v: 1, kind: "github", sentAt: "2026-11-18T00:00:00.000Z" };
  tau({ type: "tau_queue", steering: [], followUp: [{ clientMessageId: "cm-q", origin }] });
  transport.send({ type: "queue_update", steering: [], followUp: ["later"] });
  await until(() => frames.some((frame) => frame.type === "queue_update"));
  assert.deepEqual(frames.at(-1).clientMessageIds, { steering: [], followUp: ["cm-q"] });
  assert.deepEqual(frames.at(-1).messageOrigins, { steering: [], followUp: [origin] });
  const named = await state();
  assert.equal(named.supportsClientMessageIds, true);
  assert.deepEqual(named.queuedMessages.clientMessageIds, { steering: [], followUp: ["cm-q"] });

  tau({ type: "tau_message_identity", clientMessageId: "cm-1", origin });
  transport.send({ type: "message_start", message: { role: "user", content: "hi" } });
  transport.send({ type: "message_end", message: { role: "user", content: "hi" } });
  transport.send({ type: "message_start", message: { role: "user", content: "unnamed" } });
  await until(() => frames.filter((frame) => frame.type === "message_start").length === 2);
  const users = frames.filter((frame) => frame.type === "message_start" || frame.type === "message_end");
  assert.deepEqual(users.map((frame) => frame.clientMessageId ?? null), ["cm-1", "cm-1", null], "a name covers one message");
  assert.deepEqual(users[0].origin, origin);
  assert.equal(frames.some((frame) => frame.type.startsWith("tau_")), false, "extension frames are consumed");
  await proc.dispose(0);
});

test("a failed response rejects with RpcCommandError", async () => {
  const transport = makeTransport();
  transport.onLine = (frame) => frame.id && transport.send({ id: frame.id, type: "response", command: frame.type, success: false, error: "busy" });
  const proc = startProcess(transport);
  await proc.waitReady();
  await assert.rejects(proc.sendCommand({ type: "new_session" }), (error) => {
    assert.ok(error instanceof RpcCommandError);
    assert.equal(error.command, "new_session");
    assert.equal(error.message, "busy");
    return true;
  });
  await proc.dispose(0);
});

test("RpcProcess does not create a separate Windows console", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  assert.equal(transport.spawnCalls[0][2].windowsHide, true);
  if (process.platform === "win32") assert.equal(transport.spawnCalls[0][2].detached, false);
  await proc.dispose(0);
});

test("pi events and bridged extension_ui_request frames are delivered; a crash rejects pending commands", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame));

  transport.send({ type: "agent_start" });
  transport.send({ type: "session", sessionId: "s2", sessionFile: "/s/s2.jsonl", cwd: "/w" });
  transport.send({
    type: "extension_ui_request",
    id: "ext-1",
    method: "input",
    title: "__tau_host_tool__",
    placeholder: JSON.stringify({ toolName: "open_file", args: { path: "README.md" } }),
  });
  transport.send({
    type: "extension_ui_request",
    id: "ext-2",
    method: "input",
    title: "__tau_ask__",
    placeholder: JSON.stringify({ questions: [{ question: "Proceed?" }] }),
  });
  transport.send({ type: "extension_ui_request", id: "ext-3", method: "notify", message: "hi", notifyType: "info" });
  await until(() => frames.length === 5);
  assert.deepEqual(frames, [
    { type: "agent_start" },
    { type: "session", sessionId: "s2", sessionFile: "/s/s2.jsonl", cwd: "/w" },
    { type: "host_tool_call", id: "ext-1", toolName: "open_file", arguments: { path: "README.md" } },
    { type: "ui_request", id: "ext-2", method: "askDialog", args: [{ questions: [{ question: "Proceed?" }] }] },
    { type: "notice", level: "info", message: "hi" },
  ]);

  proc.sendFrame({ type: "host_tool_result", id: "ext-1", result: { content: [{ type: "text", text: "opened" }] }, isError: false });
  proc.sendFrame({ type: "ui_response", id: "ext-2", value: { answers: {} } });
  await until(() => transport.lines.length === 2);
  assert.deepEqual(transport.lines, [
    { type: "extension_ui_response", id: "ext-1", value: JSON.stringify({ content: [{ type: "text", text: "opened" }], isError: false }) },
    { type: "extension_ui_response", id: "ext-2", value: JSON.stringify({ answers: {} }) },
  ]);

  const pending = proc.sendCommand({ type: "never_returns" });
  transport.child.emit("exit", 7, null);
  await assert.rejects(pending, /pi exited/);
});

test("pi's presentation calls become ui frames; a malformed tau widget and unknown methods are dropped", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  transport.send({ type: "extension_ui_request", id: "p1", method: "setStatus", statusKey: "lint", statusText: "3 issues" });
  transport.send({ type: "extension_ui_request", id: "p2", method: "setWidget", widgetKey: "tau", widgetLines: ["not json"] });
  transport.send({ type: "extension_ui_request", id: "p3", method: "setWidget", widgetKey: "todo", widgetLines: ["one"], widgetPlacement: "belowEditor" });
  transport.send({ type: "extension_ui_request", id: "p4", method: "custom" });
  transport.send({ type: "extension_ui_request", id: "p5", method: "setTitle", title: "pi" });
  transport.send({ type: "extension_ui_request", id: "p6", method: "set_editor_text", text: "draft" });
  await until(() => frames.length === 4);
  assert.deepEqual(frames, [
    { type: "ui", id: "p1", method: "setStatus", statusKey: "lint", statusText: "3 issues" },
    { type: "ui", id: "p3", method: "setWidget", widgetKey: "todo", widgetLines: ["one"], widgetPlacement: "belowEditor" },
    { type: "ui", id: "p5", method: "setTitle", title: "pi" },
    { type: "ui", id: "p6", method: "set_editor_text", text: "draft" },
  ]);
});

test("standard extension_ui_request dialogs translate to ui_request and ui_response", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  transport.send({ type: "extension_ui_request", id: "u9", method: "select", title: "Choose", options: ["a"] });
  await until(() => frames.length === 1);
  assert.deepEqual(frames, [
    { type: "ui_request", id: "u9", method: "select", args: ["Choose", ["a"]] },
  ]);
  proc.sendFrame({ type: "ui_response", id: "u9", value: "a" });
  await until(() => transport.lines.length === 1);
  assert.deepEqual(transport.lines, [{ type: "extension_ui_response", id: "u9", value: "a" }]);
  await proc.dispose(0);
});

test("RpcProcess times out commands with RpcCommandTimeoutError and drops late response frames", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame));

  const keepAlive = setInterval(() => {}, 10);
  try {
    await assert.rejects(proc.sendCommand({ type: "slow_command" }, 20), (err) => {
      assert.ok(err instanceof RpcCommandTimeoutError);
      assert.equal(err.command, "slow_command");
      assert.equal(err.timeoutMs, 20);
      return true;
    });
  } finally {
    clearInterval(keepAlive);
  }
  const slow = transport.commands.find((command) => command.type === "slow_command");
  transport.send({ id: slow.id, type: "response", command: "slow_command", success: true, data: "late" });
  await tick();
  assert.deepEqual(frames, []);
  await proc.dispose(0);
});

for (const type of ["clear_queue"]) {
  test(`${type} times out without replaying, misrouting late ACKs, or interrupting long commands`, async (t) => {
    const transport = makeTransport();
    const proc = startProcess(transport);
    await proc.waitReady();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wrapper = new AgentSessionWrapper(proc, process.cwd(), null, "", undefined, onlineHost);
    wrapper.start();

    try {
      let loginSettled = false;
      const login = wrapper.send({ type: "export_html" });
      void login.then(() => { loginSettled = true; }, () => { loginSettled = true; });
      let mutationError;
      const mutation = wrapper.send({ type });
      void mutation.catch((error) => { mutationError = error; });
      await tick();
      const first = transport.commands.find((command) => command.type === type);
      assert.ok(first, "the child accepted the queue mutation but withheld its ACK");

      t.mock.timers.tick(5_000);
      await tick();
      assert.equal(mutationError?.name, "RpcCommandTimeoutError", "a hung queue mutation must reject within five seconds");
      assert.equal(mutationError.command, type);
      assert.equal(wrapper.isAlive(), true, "queue timeout must not kill unrelated work");
      assert.equal(loginSettled, false);

      let nextSettled = false;
      const next = wrapper.send({ type });
      void next.then(() => { nextSettled = true; }, () => { nextSettled = true; });
      await tick();
      const mutations = transport.commands.filter((command) => command.type === type);
      assert.equal(mutations.length, 2, "the timed-out mutation must not be automatically replayed");
      const second = mutations[1];
      transport.send({ id: first.id, type: "response", command: type, success: true, data: { steering: [], followUp: ["queued-first"] } });
      await tick();
      assert.equal(nextSettled, false, "a late ACK must not settle a subsequent queue mutation");

      transport.send({ id: second.id, type: "response", command: type, success: true, data: { steering: [], followUp: ["queued-next"] } });
      assert.deepEqual(await next, { steering: [], followUp: ["queued-next"] });
      t.mock.timers.tick(60_000);
      await tick();
      assert.equal(loginSettled, false, "long unrelated commands retain their unlimited transport wait");
      const loginCommand = transport.commands.find((command) => command.type === "export_html");
      transport.send({ id: loginCommand.id, type: "response", command: "export_html", success: true, data: { path: "/tmp/s.html" } });
      assert.deepEqual(await login, { path: "/tmp/s.html" });
    } finally {
      await wrapper.destroyAndWait();
    }
  });
}

function makeInjectedTransport() {
  const listeners = { line: [], stderr: [], exit: [] };
  const transport = {
    endInputCalls: 0,
    write(line, callback) {
      const command = JSON.parse(line);
      callback(null);
      queueMicrotask(() => {
        const response = {
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: command.type === "get_state" ? { isStreaming: false } : undefined,
        };
        for (const listener of listeners.line) listener(JSON.stringify(response));
      });
    },
    onLine(listener) { listeners.line.push(listener); },
    onStderr(listener) { listeners.stderr.push(listener); },
    onExit(listener) { listeners.exit.push(listener); },
    endInput() {
      transport.endInputCalls += 1;
      queueMicrotask(() => { for (const listener of listeners.exit) listener(0, null); });
    },
    killTree() {},
  };
  return transport;
}

test("RpcProcess runs over an injected transport", async () => {
  const transport = makeInjectedTransport();
  const proc = new RpcProcess({ cwd: process.cwd(), transport });
  await proc.waitReady();
  assert.deepEqual(await proc.sendCommand({ type: "get_state" }), { isStreaming: false });
  await proc.dispose(0);
  assert.equal(transport.endInputCalls, 1);
  assert.equal(proc.isAlive, false);
  assert.equal(proc.exitDetails?.code, 0);
});

function makeAdoptedTransport(held) {
  const readers = [];
  const transport = {
    endInputCalls: 0,
    answer: () => {},
    write(line, callback) {
      callback(null);
      queueMicrotask(() => transport.answer(JSON.parse(line)));
    },
    onLine(listener) {
      readers.push(listener);
      for (const line of held) listener(line);
    },
    onStderr() {},
    onExit(listener) { transport.exit = listener; },
    endInput() {
      transport.endInputCalls += 1;
      queueMicrotask(() => transport.exit?.(0, null));
    },
    killTree() {},
    send(record) { for (const reader of readers) reader(JSON.stringify(record)); },
  };
  return transport;
}

test("an adopted RpcProcess needs no startup probe and holds live frames until the replay is released", async () => {
  const transport = makeAdoptedTransport([JSON.stringify({ type: "agent_start" })]);
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: true });
  assert.deepEqual(await proc.waitReady(1), { type: "ready" });
  transport.answer = (command) => transport.send({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "s" } });
  assert.deepEqual(await proc.sendCommand({ type: "get_state" }, 1_000), { sessionId: "s" }, "commands work while frames are held");

  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id ?? frame.type));
  transport.send({ type: "message_update", id: "live" });
  assert.deepEqual(frames, [], "live frames wait for the replay");

  proc.replay([
    JSON.stringify({ type: "ui_request", id: 1, method: "askDialog", args: [[]] }),
    JSON.stringify({ type: "host_tool_call", id: "h1", toolName: "notify" }),
  ]);
  assert.deepEqual(frames, [1, "h1"], "the replay is delivered at once; live frames are still held");
  proc.release();
  assert.deepEqual(frames, [1, "h1", "agent_start", "live"]);
  assert.equal(proc.isAlive, true);
  await proc.dispose(0);
});

test("an adopted RpcProcess delivers a request both replayed and held once", async () => {
  const requests = [
    { type: "extension_ui_request", id: "u1", method: "confirm", title: "t", message: "m" },
    { type: "host_tool_call", id: "h1", toolName: "send_to_session" },
  ];
  const transport = makeAdoptedTransport([...requests, { type: "host_tool_call", id: "h2" }].map((record) => JSON.stringify(record)));
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: true });
  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id));
  proc.replay(requests.map((record) => JSON.stringify(record)));
  proc.release();
  assert.deepEqual(frames, ["u1", "h1", "h2"]);
  await proc.dispose(0);
});

test("an adopted RpcProcess whose output outgrows the hold cap fails its commands and its replay", async () => {
  const { LINK_LIMITS } = await import("../hosts/link-protocol.ts");
  const saved = LINK_LIMITS.channelBufferBytes;
  LINK_LIMITS.channelBufferBytes = 1_000;
  try {
    const transport = makeAdoptedTransport([]);
    const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: true });
    const frames = [];
    proc.onFrame((frame) => frames.push(frame));
    const pending = proc.sendCommand({ type: "get_state" });
    transport.send({ type: "message_update", text: "x".repeat(2_000) });
    await assert.rejects(pending, /exceeded 1000 bytes/);
    await assert.rejects(proc.sendCommand({ type: "get_state" }), /exceeded 1000 bytes/);
    assert.throws(() => proc.replay([]), /exceeded 1000 bytes/);
    assert.throws(() => proc.release(), /exceeded 1000 bytes/);
    assert.deepEqual(frames, [], "nothing held reaches the session");
    await proc.dispose(0);
  } finally {
    LINK_LIMITS.channelBufferBytes = saved;
  }
});
