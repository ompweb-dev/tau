import { test } from "bun:test";
import assert from "node:assert/strict";
import tauExtension from "./tau-extension.ts";

/** The extension's message-identity handlers against a fake pi: what `tau_message_identity` each user message gets. */
function harness() {
  const handlers = new Map(), commands = new Map(), identities = [];
  tauExtension({
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name, spec) => commands.set(name, spec),
    registerTool() {}, appendEntry() {}, setActiveTools() {}, getActiveTools: () => [], getAllTools: () => [],
  });
  let idle = true;
  const ctx = {
    isIdle: () => idle,
    ui: { setWidget: (_key, lines) => { const frame = JSON.parse(lines[0]); if (frame.type === "tau_message_identity") identities.push(frame.clientMessageId); } },
    sessionManager: { getBranch: () => [] },
  };
  const emit = (event, payload) => { for (const handler of handlers.get(event) ?? []) handler(payload, ctx); };
  return {
    identities,
    setIdle: (value) => { idle = value; },
    name: (clientMessageId, text) => commands.get("tau_meta").handler(JSON.stringify({ action: "name", clientMessageId, text }), ctx),
    input: (text, streamingBehavior) => emit("input", { text, streamingBehavior }),
    start: (content) => emit("message_start", { message: { role: "user", content } }),
  };
}

test("a named prompt pi refused after its input handlers ran never names the next user message", () => {
  const pi = harness();
  pi.name("a", "prompt A");
  pi.input("prompt A"); // pi then throws "No API key found": no message_start for A
  pi.input("typed in the terminal");
  pi.start("typed in the terminal");
  assert.deepEqual(pi.identities, []);
});

test("a named prompt keeps its id when a skill, template or another extension rewrites its text", () => {
  const pi = harness();
  pi.name("a", "prompt A");
  pi.input("prompt A");
  pi.start("prompt A\n\nContext another extension added");
  assert.deepEqual(pi.identities, ["a"]);
});

test("names with the same text go to their prompts in order", () => {
  const pi = harness();
  pi.name("first", "continue");
  pi.name("second", "continue");
  pi.input("continue");
  pi.start("continue");
  pi.input("continue");
  pi.start("continue");
  assert.deepEqual(pi.identities, ["first", "second"]);
});

test("a bare prompt pi refuses during a run never gives its id to the run's next queued message", () => {
  const pi = harness();
  pi.setIdle(false);
  pi.name("refused", "prompt X");
  pi.input("prompt X"); // pi: "Agent is already processing"
  pi.name("steer", "steer Y");
  pi.input("steer Y", "steer");
  pi.start("steer Y");
  assert.deepEqual(pi.identities, ["steer"]);
});

test("only the newest 32 pending names are kept, so a name pi never admitted cannot wait for a twin forever", () => {
  const pi = harness();
  pi.name("stale", "same text");
  for (let n = 0; n < 32; n++) pi.name(`n${n}`, `other ${n}`);
  pi.input("same text");
  pi.start("same text");
  assert.deepEqual(pi.identities, []);
});

test("a refused slash prompt's name is cleared by the next prompt, which never takes it", () => {
  const pi = harness();
  pi.name("skill", "/skill:x run");
  pi.input("/skill:x run"); // refused: no API key
  pi.input("typed prompt");
  pi.start("typed prompt");
  assert.deepEqual(pi.identities, []);
});

test("a follow-up whose input fires while a prompt still prepares never swaps ids with it", () => {
  const pi = harness();
  pi.name("A", "prompt A");
  pi.input("prompt A");
  pi.name("F", "follow-up F");
  pi.input("follow-up F"); // pi strips streamingBehavior while not yet streaming
  pi.start("prompt A");
  pi.start("follow-up F");
  assert.deepEqual(pi.identities, ["A", "F"]);
});

test("an unnamed prompt after a refused named one gets no id", () => {
  const pi = harness();
  pi.name("A", "prompt A");
  pi.input("prompt A"); // refused: no API key
  pi.input("typed in the terminal");
  pi.start("typed in the terminal");
  assert.deepEqual(pi.identities, []);
});
