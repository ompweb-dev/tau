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
  const ctx = {
    ui: { setWidget: (_key, lines) => { const frame = JSON.parse(lines[0]); if (frame.type === "tau_message_identity") identities.push(frame.clientMessageId); } },
    sessionManager: { getBranch: () => [] },
  };
  const emit = (event, payload) => { for (const handler of handlers.get(event) ?? []) handler(payload, ctx); };
  return {
    identities,
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

test("a named prompt's message gets its id; another text does not take it", () => {
  const pi = harness();
  pi.name("a", "prompt A");
  pi.input("prompt A");
  pi.start("something an extension sent");
  assert.deepEqual(pi.identities, []);
  pi.name("b", "prompt B");
  pi.input("prompt B");
  pi.start("prompt B");
  assert.deepEqual(pi.identities, ["b"]);
});

test("only the newest 32 pending names are kept, so a name pi never admitted cannot wait for a twin forever", () => {
  const pi = harness();
  pi.name("stale", "same text");
  for (let n = 0; n < 32; n++) pi.name(`n${n}`, `other ${n}`);
  pi.input("same text");
  pi.start("same text");
  assert.deepEqual(pi.identities, []);
});
