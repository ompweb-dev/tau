import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ChannelTable } from "./daemon-channels.ts";
import { RESUME_PROMPT } from "./host-resume.ts";
import { LINK_PROTOCOL_VERSION } from "./link-protocol.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMessageDelta } from "../message-delta.ts";

const SAVED = "11111111-1111-4111-8111-111111111111";
const MOVED = "22222222-2222-4222-8222-222222222222";
const launch = { cwd: "/tmp", recordedCwd: null, sessionFile: "/tmp/s.jsonl" };
/** Commands the daemon sends on its own: the fake child answers them, never a link's. */
const DAEMON_OPS = new Set(["set_subagent_subscription", "set_host_tools", "set_host_uri_schemes"]);
/** Lines the daemon forwards to the child that answer a request rather than issue a command. */
const REPLIES = new Set(["ui_response", "extension_ui_response", "host_tool_result", "host_uri_result"]);
const cmd = (id, op, args = {}) => JSON.stringify({ ...args, type: op, id });
const ev = (child, event) => child.emit(event);
const res = (id, data, extra = {}) => ({ type: "response", id, success: true, ...(data === undefined ? {} : { data }), ...extra });
/** The commands links sent, as the child received them (ids remapped by the daemon). */
/** The daemon's own startup `get_state` is the first line it writes; anything else a link sent. */
/** A daemon-owned companion-extension command (`/tau_host_tools`, the port of set_host_tools). */
const extensionCommand = frame => frame.type === "prompt" && typeof frame.message === "string" && frame.message.startsWith("/tau_");
const own = child => child.writes.filter(frame => !REPLIES.has(frame.type) && frame !== child.writes[0] && !DAEMON_OPS.has(frame.type) && !extensionCommand(frame) && frame.message !== RESUME_PROMPT);
const stdoutFrames = (h, linkId) => h.output.filter(item => item.body.type === "stdout" && (linkId === undefined || item.id === linkId)).map(item => JSON.parse(item.body.line));
/** `state`: fields the child's startup `get_state` answer overrides. */
function harness(state = {}) {
  const children = [], output = [], changed = [], logs = [];
  // How a spawned child answers the daemon's startup `get_state`; a test may replace it (exit during startup, for one).
  const hooks = { startup: (child, request, probe) => child.emit(res(probe.id, { sessionId: request.sessionFile ? SAVED : randomUUID(), sessionFile: request.sessionFile, cwd: request.cwd, ...state }, { command: "get_state" })) };
  const links = ["l1", "l2"].map(id => ({ id, version: LINK_PROTOCOL_VERSION, isUp: () => true,
    queue(body, key) { output.push({ id, body, key }); return 1; }, output(body) { output.push({ id, body }); }, discard() {} }));
  async function spawn(request) {
    const listeners = {}, writes = [], exits = [];
    const transport = {
      write(line, callback) {
        const frame = JSON.parse(line); writes.push(frame); callback?.(null);
        if (writes.length === 1 && frame.type === "get_state") setTimeout(() => hooks.startup(child, request, frame), 0);
        else if (!REPLIES.has(frame.type) && !hooks.holdDaemonReplies && (DAEMON_OPS.has(frame.type) || extensionCommand(frame) || frame.message === RESUME_PROMPT)) {
          queueMicrotask(() => listeners.line?.(JSON.stringify(res(frame.id, {}))));
        }
      },
      killTree(force) { child.kills.push(force); if (!child.holdExit) child.exit(force); },
      onLine(fn) { listeners.line = fn; return () => {}; }, onStderr(fn) { listeners.stderr = fn; return () => {}; },
      onExit(fn) { exits.push(fn); return () => {}; },
    };
    const child = { request, transport, writes, kills: [], holdExit: false, exit(force = false) { for (const exit of exits) exit(0, force ? "SIGKILL" : null); }, emit(frame) { listeners.line?.(JSON.stringify(frame)); }, stderr(chunk) { listeners.stderr?.(chunk); } };
    children.push(child);
    return { transport, cwd: request.cwd, fellBack: false };
  }
  const table = new ChannelTable({ sessionId: () => SAVED, prepareLaunch: x => x, log: message => logs.push(message), channelsChanged: ch => changed.push(ch), spawn });
  return { table, children, output, changed, logs, hooks, spawn, a: links[0], b: links[1] };
}

test("concurrent opens spawn once; command order and replies stay source-owned", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.table.open(h.a, { sessionId: SAVED, launch }), h.table.open(h.b, { sessionId: SAVED, launch })]);
  assert.equal(h.children.length, 1); assert.equal(a.ch, b.ch); h.table.release(h.a, a.ch); h.table.release(h.b, b.ch);
  // Both links number their commands 1: the daemon gives each its own id toward the child and restores the link's on the reply.
  h.table.stdin(h.a, a.ch, cmd(1, "get_messages", { who: "a" })); h.table.stdin(h.b, a.ch, cmd(1, "get_messages", { who: "b" }));
  const sent = own(h.children[0]);
  assert.deepEqual(sent.map(frame => frame.who), ["a", "b"]);
  assert.notEqual(sent[0].id, sent[1].id);
  for (const frame of sent) h.children[0].emit(res(frame.id, { who: frame.who }));
  assert.deepEqual(stdoutFrames(h).map(frame => [frame.id, frame.data.who]), [[1, "a"], [1, "b"]]);
  assert.deepEqual(h.output.map(item => item.id), ["l1", "l2"]);
  assert.throws(() => h.table.stdin({ ...h.a, id: "guessed" }, a.ch, cmd(1, "get_messages")));
  await h.table.stop();
});

test("pi's delta-only message updates get an id and the shape the reducer rebuilds; a joining link gets the whole message", async () => {
  // Recorded from pi 1.5.2 (`pi --mode rpc`, an OpenAI-compatible stub): text, then a read call with streamed arguments.
  const recorded = readFileSync(new URL("../../tests/fixtures/pi-delta-stream.ndjson", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch);
  const child = h.children[0];
  const toolDelta = recorded.findIndex(frame => frame.assistantMessageEvent?.type === "toolcall_delta");
  for (const frame of recorded.slice(0, toolDelta + 1)) child.emit(frame);
  const b = await h.table.open(h.b, { sessionId: SAVED, launch });
  assert.deepEqual(JSON.parse(b.streaming).message.content.map(block => block.type), ["text", "toolCall"]);
  for (const frame of recorded.slice(toolDelta + 1)) child.emit(frame);
  const forwarded = stdoutFrames(h, "l1").filter(frame => frame.type.startsWith("message_"));
  const [start, ...rest] = forwarded;
  const end = rest.pop();
  assert.ok(typeof start.messageId === "string" && forwarded.every(frame => frame.messageId === start.messageId));
  let message = start.message;
  for (const update of rest) message = applyMessageDelta(message, update.assistantMessageEvent);
  assert.deepEqual(message.content, end.message.content, "the rebuilt message is the one pi ends with");
  await h.table.stop();
});

test("join captures full stream and dialogs before later deltas; first answer closes the other UI", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch);
  const child = h.children[0]; ev(child, { type: "message_start", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "one" }] } });
  child.emit({ type: "ui_request", id: 1, method: "ask", args: {} });
  const b = await h.table.open(h.b, { sessionId: SAVED, launch });
  assert.equal(JSON.parse(b.streaming).message.content[0].text, "one"); assert.equal(JSON.parse(b.pending[0]).id, 1);
  ev(child, { type: "message_update", messageId: "m", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "two" } });
  assert.equal(h.output.filter(x => x.id === "l2").length, 0); h.table.release(h.b, b.ch);
  assert.equal(h.output.filter(x => x.id === "l2").length, 1);
  h.table.stdin(h.b, b.ch, JSON.stringify({ type: "ui_response", id: 1, value: "x" })); h.table.stdin(h.a, a.ch, JSON.stringify({ type: "ui_response", id: 1, value: "y" }));
  assert.equal(child.writes.filter(frame => frame.type === "ui_response").length, 1);
  assert.ok(h.output.some(x => x.id === "l1" && x.body.type === "stdout" && JSON.parse(x.body.line).type === "ui_end" && JSON.parse(x.body.line).id === 1));
  await h.table.stop();
});

test("a private res is never broadcast; a session frame after a persistence notice moves identity and keeps aliases", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch);
  const b = await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.b, b.ch);
  ev(h.children[0], { type: "notice", source: "session-persistence", level: "info" });
  h.output.length = 0;
  h.table.stdin(h.a, a.ch, cmd("a", "get_state_probe"));
  h.children[0].emit(res(own(h.children[0])[0].id, { pad: "x".repeat(1100000) }));
  assert.equal(h.output.filter(x => x.id === "l2").length, 0);
  assert.deepEqual(h.output.filter(x => x.id === "l1").map(x => JSON.parse(x.body.line).id), ["a"]);
  h.children[0].emit({ type: "session", sessionId: MOVED, sessionFile: "/tmp/moved.jsonl" });
  assert.equal((await h.table.open(h.b, { sessionId: SAVED, launch })).ch, a.ch);
  assert.equal((await h.table.open(h.b, { sessionId: MOVED, launch: { ...launch, sessionFile: "/tmp/moved.jsonl" } })).ch, a.ch);
  assert.equal(h.table.listing(h.a)[0].sessionId, MOVED);
  assert.equal(h.children.length, 1); await h.table.stop();
});

test("startup reads the state once for two members; links may not send daemon-owned ops", async () => {
  const h = harness();
  const a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch });
  assert.deepEqual(h.children[0].writes.map(frame => frame.type), ["get_state"]);
  for (const op of DAEMON_OPS) assert.throws(() => h.table.stdin(h.a, a.ch, cmd(1, op)), { code: "invalid_request" });
  assert.equal(h.children[0].writes.length, 1);
  assert.deepEqual(h.output, []);
  h.table.release(h.a, a.ch); await h.table.stop();
});

test("only a rejoining member that lost no output is told its stream is continuous", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch);
  assert.equal(a.continuous, undefined, "a new member needs the snapshot");
  ev(h.children[0], { type: "notice", message: "sent on" });
  const rejoined = await h.table.open(h.a, { sessionId: SAVED, launch, expectedChannel: a.ch }); h.table.release(h.a, a.ch);
  assert.equal(rejoined.continuous, true);
  // Output queued behind a pending open is superseded by that open's snapshot: not continuous.
  await h.table.open(h.a, { sessionId: SAVED, launch, expectedChannel: a.ch });
  ev(h.children[0], { type: "notice", message: "queued" });
  const behind = await h.table.open(h.a, { sessionId: SAVED, launch, expectedChannel: a.ch });
  assert.equal(behind.continuous, undefined);
  await h.table.stop();
});

test("replies nobody owns never reach a member", async () => {
  const h = harness();
  const a = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch);
  const child = h.children[0];
  h.table.stdin(h.a, a.ch, cmd(1, "get_state"));
  // A repeated answer to the daemon's own startup get_state, and an id nobody sent.
  child.emit(res(child.writes[0].id)); child.emit(res("99"));
  assert.deepEqual(stdoutFrames(h), []);
  child.emit(res(own(child)[0].id, { state: true }));
  assert.deepEqual(stdoutFrames(h).map(frame => [frame.id, frame.data]), [[1, { state: true }]]);
  await h.table.stop();
});

test("closing one membership neither kills the child nor broadcasts its late reply", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  h.table.stdin(h.a, a.ch, cmd("old", "get_messages"));
  h.table.stdin(h.b, a.ch, cmd("old", "get_messages")); // The other link's own numbering never collides.
  const [first] = own(h.children[0]);
  h.table.close(h.a, a.ch); h.children[0].emit(res(first.id, {}));
  assert.deepEqual(h.output, []); assert.equal(h.table.size, 1);
  assert.equal((await h.table.open(h.a, { sessionId: SAVED, launch })).joined, true);
  await h.table.stop();
});

test("delete fence waits for exit and prevents a concurrent reopen until the mutation completes", async () => {
  const h = harness(); await h.table.open(h.a, { sessionId: SAVED, launch });
  const gate = Promise.withResolvers(); let entered = false, reopened = false;
  const deletion = h.table.mutateSession(SAVED, async canonical => { assert.equal(canonical, SAVED); assert.equal(h.table.size, 0); entered = true; await gate.promise; return "deleted"; });
  const opening = h.table.open(h.b, { sessionId: SAVED, launch }).then(() => { reopened = true; });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(entered, true); assert.equal(reopened, false);
  gate.resolve(); assert.equal(await deletion, "deleted"); await opening; assert.equal(h.children.length, 2); await h.table.stop();
});

test("recovery and two server opens share one spawn and one daemon-owned resume prompt", async () => {
  const h = harness();
  await Promise.all([
    h.table.recover([{ sessionId: SAVED, launch }]),
    h.table.open(h.a, { sessionId: SAVED, launch }),
    h.table.open(h.b, { sessionId: SAVED, launch }),
  ]);
  assert.equal(h.children.length, 1);
  const prompts = h.children[0].writes.filter(frame => frame.type === "prompt");
  assert.equal(prompts.length, 1); assert.equal(prompts[0].message, RESUME_PROMPT); assert.deepEqual(h.output, []);
  await h.table.stop();
});

test("only the chosen callback executor receives the request but both members receive the committed result", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  for (const link of [h.a, h.b]) h.table.setTools(link, a.ch, [{ name: "open_url" }], []);
  await new Promise(resolve => setImmediate(resolve)); // pi registers the tools before it can call one
  assert.deepEqual(h.children[0].writes.filter(extensionCommand).map(frame => frame.message), [`/tau_host_tools ${JSON.stringify([{ name: "open_url" }])}`],
    "the union goes to the companion extension once");
  h.table.stdin(h.b, a.ch, cmd("p", "prompt", { message: "open" }));
  // The extension asks for the tool as an input dialog; the daemon routes it as the host_tool_call it stands for.
  h.children[0].emit({ type: "extension_ui_request", id: "7", method: "input", title: "__tau_host_tool__", placeholder: JSON.stringify({ toolCallId: "t", toolName: "open_url", args: { url: "u" } }) });
  // The non-prompting member sees only the daemon's peer-admission marker, never the callback.
  assert.deepEqual(h.output.map(item => [item.id, JSON.parse(item.body.line).type]), [["l1", "peer_message_command"], ["l2", "host_tool_call"]]);
  assert.deepEqual(JSON.parse(h.output[1].body.line), { type: "host_tool_call", id: "7", toolName: "open_url", arguments: { url: "u" } });
  h.table.stdin(h.a, a.ch, JSON.stringify({ type: "host_tool_result", id: "7", result: "no" }));
  h.table.stdin(h.b, a.ch, JSON.stringify({ type: "host_tool_result", id: "7", result: { content: [{ type: "text", text: "yes" }] }, isError: false }));
  assert.deepEqual(h.children[0].writes.filter(frame => frame.type === "extension_ui_response"),
    [{ type: "extension_ui_response", id: "7", value: JSON.stringify({ content: [{ type: "text", text: "yes" }], isError: false }) }]);
  ev(h.children[0], { type: "tool_execution_end", toolCallId: 7, toolName: "open_url", result: "yes" });
  assert.deepEqual(h.output.filter(item => JSON.parse(item.body.line).type === "tool_execution_end").map(item => item.id), ["l1", "l2"]);
  await h.table.stop();
});

test("a companion-extension command is no user message: no peer marker, no edit fence, and its reply ends it", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  h.table.stdin(h.a, a.ch, cmd("x", "prompt", { message: "/tau_btw {\"action\":\"history\"}" }));
  assert.equal(h.output.some(item => JSON.parse(item.body.line).type === "peer_message_command"), false);
  const [sent] = h.children[0].writes.filter(frame => frame.type === "prompt");
  h.children[0].emit(res(sent.id, { disposition: "handled" }, { command: "prompt" }));
  h.children[0].emit(res(sent.id, {}, { command: "prompt" }));
  assert.equal(stdoutFrames(h, "l1").filter(frame => frame.id === "x").length, 1, "the owner is dropped with its reply");
  assert.throws(() => h.table.stdin(h.b, a.ch, cmd("y", "prompt", { message: "/tau_host_tools []" })), { code: "invalid_request" });
  await h.table.stop();
});

test("a prompt_result returns under the sending link's own id, to that link only", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  h.table.stdin(h.a, a.ch, cmd(1000, "prompt", { message: "hi" }));
  const [sent] = own(h.children[0]);
  assert.notEqual(sent.id, 1000);
  h.children[0].emit(res(sent.id, { agentInvoked: true }));
  h.children[0].emit({ type: "prompt_result", id: sent.id, text: "done" });
  const results = h.output.filter(item => item.body.type === "stdout" && ["response", "prompt_result"].includes(JSON.parse(item.body.line).type));
  assert.deepEqual(results.map(item => [item.id, JSON.parse(item.body.line).type, JSON.parse(item.body.line).id]), [["l1", "response", 1000], ["l1", "prompt_result", 1000]]);
  await h.table.stop();
});

test("a prompt's outcome reaches the other members uncorrelated, so the elected notifier sees a peer's failure", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  h.table.stdin(h.a, a.ch, cmd(1000, "prompt", { message: "hi" })); h.table.stdin(h.a, a.ch, cmd(1001, "prompt", { message: "again" }));
  const [first, second] = own(h.children[0]);
  h.children[0].emit({ type: "prompt_result", id: first.id, agentInvoked: true, status: "error", error: { message: "boom" } });
  h.children[0].emit({ type: "prompt_error", id: second.id, command: "prompt", error: "No API key" });
  const outcomes = frames => frames.filter(frame => ["prompt_result", "prompt_error", "peer_prompt_outcome"].includes(frame.type));
  assert.deepEqual(outcomes(stdoutFrames(h, "l1")).map(frame => [frame.type, frame.id]), [["prompt_result", 1000], ["prompt_error", 1001]]);
  assert.deepEqual(outcomes(stdoutFrames(h, "l2")), [
    { type: "peer_prompt_outcome", outcome: { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "boom" } } },
    { type: "peer_prompt_outcome", outcome: { type: "prompt_error", command: "prompt", error: "No API key" } },
  ]);
  await h.table.stop();
});

test("shared removal never kills; permanent removal during spawn cannot attach a dead shared member", async () => {
  const removed = harness(); await removed.table.open(removed.a, { sessionId: SAVED, launch });
  removed.table.linkGone(removed.a); assert.equal(removed.table.size, 1); await removed.table.stop();
  const shared = harness();
  const a = shared.table.open(shared.a, { sessionId: SAVED, launch });
  const b = shared.table.open(shared.b, { sessionId: SAVED, launch });
  shared.table.linkGone(shared.a);
  await assert.rejects(a, error => error.code === "host_link_closed");
  const opened = await b; assert.deepEqual(shared.table.members(opened.ch).map(link => link.id), ["l2"]);
  assert.equal(shared.children.length, 1); await shared.table.stop();
});

test("concurrent opens by one member release live output only after both results are published", async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.table.open(h.a, { sessionId: SAVED, launch }), h.table.open(h.a, { sessionId: SAVED, launch })]);
  ev(h.children[0], { type: "message_start", messageId: "m", message: { role: "assistant", content: [] } });
  h.table.release(h.a, first.ch); assert.deepEqual(h.output, []);
  h.table.release(h.a, second.ch); assert.equal(h.output.length, 1);
  await h.table.stop();
});

for (const operation of ["open", "delete"]) {
  test(`a fork keeps its parent independent when the parent is ${operation}d`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-fork-identity-"));
    const parent = join(dir, "parent.jsonl"), fork = join(dir, "fork.jsonl");
    for (const [file, id] of [[parent, SAVED], [fork, MOVED]]) writeFileSync(file, `${JSON.stringify({
      type: "session", version: 3, id, cwd: "/tmp", timestamp: "2026-01-01T00:00:00Z",
    })}\n`);
    const h = harness();
    try {
      const original = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, sessionFile: parent } });
      h.children[0].emit({ type: "session", sessionId: MOVED, sessionFile: fork });
      if (operation === "open") {
        const reopened = await h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, sessionFile: parent } });
        assert.notEqual(reopened.ch, original.ch);
        assert.equal(h.children.length, 2);
      } else {
        await h.table.mutateSession(SAVED, async canonical => {
          assert.equal(canonical, SAVED, "deleting the parent must never target the fork");
          assert.equal(h.table.size, 1, "the fork's process must remain alive");
        });
      }
    } finally {
      await h.table.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a native copy-on-write move retains aliases even while the original file still exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-native-move-"));
  const parent = join(dir, "original.jsonl"), moved = join(dir, "moved.jsonl");
  writeFileSync(parent, `${JSON.stringify({ type: "session", version: 3, id: SAVED, cwd: "/tmp" })}\n`);
  const h = harness();
  try {
    const opened = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, sessionFile: parent } });
    ev(h.children[0], { type: "notice", source: "session-persistence", level: "info", message: "Session moved" });
    h.children[0].emit({ type: "session", sessionId: MOVED, sessionFile: moved });
    assert.equal((await h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, sessionFile: parent } })).ch, opened.ch);
    assert.equal((await h.table.open(h.b, { sessionId: MOVED, launch: { ...launch, sessionFile: moved } })).ch, opened.ch);
    assert.equal(h.children.length, 1);
  } finally {
    await h.table.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a passive join for an exited advertised channel never respawns its saved file", async () => {
  const h = harness();
  const first = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.children[0].exit();
  await assert.rejects(h.table.open(h.b, { sessionId: SAVED, launch, expectedChannel: first.ch }),
    error => error.status === 404 && error.code === "session_not_running");
  assert.equal(h.children.length, 1);
  assert.equal(h.table.size, 0);
  await h.table.stop();
});

test("destructive operations on an old copy-on-write file never retarget its live continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-native-move-delete-"));
  const original = join(dir, "original.jsonl"), moved = join(dir, "moved.jsonl");
  writeFileSync(original, `${JSON.stringify({ type: "session", version: 3, id: SAVED, cwd: "/tmp" })}\n`);
  const h = harness();
  try {
    await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, sessionFile: original } });
    ev(h.children[0], { type: "notice", source: "session-persistence", level: "info", message: "Session moved" });
    h.children[0].emit({ type: "session", sessionId: MOVED, sessionFile: moved });
    let requested;
    await h.table.mutateSession(SAVED, async id => { requested = id; });
    assert.equal(requested, SAVED);
    assert.equal(h.table.size, 1);
    assert.deepEqual(h.children[0].kills, [], "the moved session's process still owns only the continuation");
  } finally {
    await h.table.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session frame updates the listing even in the middle of a run", async () => {
  const h = harness();
  try {
    const opened = await h.table.open(h.a, { sessionId: SAVED, launch });
    h.table.release(h.a, opened.ch);
    const child = h.children[0];
    ev(child, { type: "agent_start" });
    ev(child, { type: "notice", source: "session-persistence", level: "info", message: "Session moved" });
    child.emit({ type: "session", sessionId: MOVED, sessionFile: "/tmp/moved-mid-run.jsonl" });
    assert.equal(h.table.listing(h.a)[0].sessionId, MOVED);
    assert.equal(h.children.length, 1);
  } finally { await h.table.stop(); }
});

test("a history-edit lease refuses a competing editor and other links' mutations until released, dropped or closed", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  const prompts = () => h.children[0].writes.filter(frame => frame.type === "prompt").map(frame => frame.message);
  h.table.editLease(h.a, a.ch, true);
  assert.throws(() => h.table.editLease(h.b, a.ch, true), { status: 409, code: "session_busy" }, "a competing editor fails before its preflight");
  h.table.editLease(h.b, a.ch, false); // Releasing a lease it does not hold changes nothing.
  h.table.stdin(h.b, a.ch, cmd("peer", "prompt", { message: "peer" }));
  h.table.stdin(h.b, a.ch, cmd("read", "get_messages"));
  h.table.stdin(h.a, a.ch, cmd("edit", "prompt", { message: "edit" }));
  assert.deepEqual(prompts(), ["edit"]);
  assert.ok(h.children[0].writes.some(frame => frame.type === "get_messages"), "reads are never fenced");
  const refused = stdoutFrames(h, "l2").find(frame => frame.id === "peer");
  assert.equal(refused?.code, "session_busy");
  h.table.editLease(h.a, a.ch, false);
  h.table.editLease(h.b, a.ch, true); h.table.editLease(h.b, a.ch, false); // Free again: B may take it.
  h.table.stdin(h.b, a.ch, cmd("after", "prompt", { message: "after" }));
  h.table.editLease(h.a, a.ch, true); h.table.linkDown(h.a); // A restarted server forgets its edit.
  h.table.stdin(h.b, a.ch, cmd("dropped", "prompt", { message: "dropped" }));
  h.table.editLease(h.a, a.ch, true); h.table.close(h.a, a.ch);
  h.table.stdin(h.b, a.ch, cmd("closed", "prompt", { message: "closed" }));
  assert.deepEqual(prompts(), ["edit", "after", "dropped", "closed"]);
  await h.table.stop();
});

test("an exit between join and the open result's release still reaches the joining link", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.children[0].exit();
  assert.deepEqual(h.output.filter(item => item.body.type === "exit"), []);
  h.table.release(h.a, a.ch);
  assert.deepEqual(h.output.filter(item => item.body.type === "exit").map(item => item.id), ["l1"]);
  await h.table.stop();
});

test("a reopen keeps this link's queued command replies and drops output its snapshot supersedes", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.stdin(h.a, a.ch, cmd("q", "get_messages"));
  h.children[0].emit(res(own(h.children[0])[0].id, {}));
  ev(h.children[0], { type: "notice", message: "stale" });
  await h.table.open(h.a, { sessionId: SAVED, launch, expectedChannel: a.ch });
  h.table.release(h.a, a.ch); h.table.release(h.a, a.ch);
  assert.deepEqual(stdoutFrames(h).map(frame => frame.id ?? "output"), ["q"]);
  await h.table.stop();
});

test("a stop the daemon makes names its reason on the exit; a crash names none", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch);
  h.table.kill(h.a, a.ch, false);
  assert.deepEqual(h.output.filter(item => item.body.type === "exit").map(item => item.body.reason), ["asked"]);
  const b = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, b.ch);
  h.children[1].exit();
  assert.deepEqual(h.output.filter(item => item.body.type === "exit").map(item => item.body.reason), ["asked", undefined]);
  await h.table.stop();
});

test("a resumed session stays recorded as running between omp's reply and agent_start", async () => {
  const h = harness(), entry = { sessionId: SAVED, launch };
  assert.deepEqual(await h.table.recover([entry]), [], "the harness answers the prompt before any agent_start");
  assert.deepEqual(h.table.running().map(item => item.sessionId), [SAVED], "no gap where a crash would lose the resume");
  ev(h.children[0], { type: "agent_start" });
  ev(h.children[0], { type: "agent_end", isTerminal: true });
  ev(h.children[0], { type: "session_settled" });
  assert.deepEqual(h.table.running(), [], "a finished resumed run is no longer recorded");
  await h.table.stop();
});

test("a pooled creation joins across shared links once and cannot change intent or restart after exit", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  const created = { ...launch, sessionFile: "", creationId: "shared-pool-creation" };
  const [first, joined] = await Promise.all([
    h.table.open(h.a, { sessionId: null, launch: created, preparing: true }),
    h.table.open(h.b, { sessionId: null, launch: created, preparing: true }),
  ]);
  assert.equal(h.children.length, 1);
  assert.equal(first.ch, joined.ch);
  assert.equal(h.table.listing(h.b)[0].creationId, created.creationId);
  h.table.release(h.a, first.ch); h.table.release(h.b, first.ch);
  ev(h.children[0], { type: "agent_start" });
  assert.equal(h.table.activeTurns, 1, "the shared child is counted once, not once per web app");
  ev(h.children[0], { type: "agent_end", isTerminal: true });
  assert.equal(h.table.activeTurns, 0, "an unsettled but idle child is not an executing turn");
  await assert.rejects(h.table.open(h.a, { sessionId: null, launch: { ...created, cwd: "/elsewhere" } }), { code: "creation_conflict" });
  h.children[0].exit();
  await assert.rejects(h.table.open(h.a, { sessionId: null, launch: created }), { code: "creation_conflict" });
  assert.equal(h.children.length, 1, "terminal identities must never launch replacements");
});

const VERSION = "a".repeat(64);

test("only a start with a configuration version names the opening link as its configuration server; a join never respawns", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.a.login = { url: "https://a.example", token: "a" };
  h.b.login = { url: "https://b.example", token: "b" };
  const first = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, configVersion: VERSION } });
  assert.equal(h.children[0].request.configServer, "https://a.example");
  const joined = await h.table.open(h.b, { sessionId: SAVED, launch });
  assert.equal(joined.ch, first.ch);
  assert.equal(h.children.length, 1, "the joining link reuses the process");
});

test("a wire-supplied configuration server never reaches the spawn", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.a.login = { url: "https://a.example", token: "a" };
  await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, configServer: "https://evil.example" } });
  assert.equal("configServer" in h.children[0].request, false);
});

test("the recorded launch never keeps the configuration version or its server", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.a.login = { url: "https://a.example", token: "a" };
  const opened = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, configVersion: VERSION } });
  h.table.release(h.a, opened.ch);
  h.children[0].emit({ type: "session", sessionId: MOVED, sessionFile: "/tmp/moved.jsonl", cwd: "/tmp" });
  h.children[0].emit({ type: "agent_start" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(h.table.running().map(({ sessionId, launch: recorded }) => [sessionId, recorded.sessionFile, "configVersion" in recorded, "configServer" in recorded]),
    [[MOVED, "/tmp/moved.jsonl", false, false]]);
});

test("a start keeps the configuration version only as 64 hex characters", async (t) => {
  for (const [given, kept] of [["x", undefined], [VERSION.toUpperCase(), undefined], [7, undefined], [VERSION, VERSION]]) {
    const h = harness();
    t.after(() => h.table.stop());
    h.a.version = LINK_PROTOCOL_VERSION; h.a.login = { url: "https://a.example", token: "a" };
    await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, configVersion: given } });
    assert.equal(h.children[0].request.configVersion, kept);
    assert.equal("configVersion" in h.children[0].request, kept !== undefined);
    assert.equal("configServer" in h.children[0].request, kept !== undefined);
  }
});

test("an omp that exits during startup logs the last 500 bytes of its stderr to the daemon log only", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.hooks.startup = child => { child.stderr("x".repeat(600)); child.stderr("stderr line refused\n"); child.exit(); };
  await assert.rejects(h.table.open(h.a, { sessionId: SAVED, launch }), { code: "host_process_exited" });
  const lines = h.logs.filter(line => line.includes("exited during startup"));
  assert.equal(lines.length, 1, h.logs.join(" | "));
  assert.ok(lines[0].includes(JSON.stringify("x".repeat(480) + "stderr line refused\n")), lines[0]);
  assert.ok(!lines[0].includes("x".repeat(481)), "at most 500 bytes");
  assert.deepEqual(h.output, [], "nothing goes over the link");
});

test("stderr is dropped once startup settles and never logged on a later exit", async (t) => {
  const h = harness();
  t.after(() => h.table.stop());
  h.hooks.startup = (child, request, probe) => { child.stderr("early text"); child.emit(res(probe.id, { sessionId: SAVED, sessionFile: request.sessionFile, cwd: request.cwd }, { command: "get_state" })); };
  const opened = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, opened.ch);
  h.children[0].stderr("late text");
  h.children[0].exit();
  assert.ok(!h.logs.some(line => line.includes("early text") || line.includes("late text")), h.logs.join(" | "));
});
