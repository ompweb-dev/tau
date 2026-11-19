import assert from "node:assert/strict";
import test from "node:test";

const { PendingRequests } = await import("./pending-requests.ts");

const line = (frame) => JSON.stringify(frame);
const event = (ev) => line(ev);
const LIMIT = 1024 * 1024;

test("a dialog answered on stdin is no longer open", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ type: "extension_ui_request", id: "1", method: "input", title: "Name" }));
  assert.equal(pending.lines().length, 1);
  pending.noteStdin(line({ type: "extension_ui_response", id: "1", value: "ok" }));
  assert.deepEqual(pending.lines(), []);
});

test("an open host_tool_call keeps its raw line until host_tool_cancel names it", () => {
  const pending = new PendingRequests(LIMIT);
  const call = line({ type: "host_tool_call", id: "1", toolCallId: "c1", toolName: "browser", arguments: {} });
  pending.noteStdout(event({ type: "message_update", text: "unrelated" }));
  pending.noteStdout(call);
  assert.deepEqual(pending.lines(), [call]);
  pending.noteStdout(line({ type: "host_tool_cancel", id: "9", targetId: "1" }));
  assert.deepEqual(pending.lines(), []);
});

test("host_tool_result on stdin closes the call; ui_end closes a dialog numbered alike", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ type: "host_tool_call", id: "1", toolCallId: "c1", toolName: "browser", arguments: {} }));
  const confirm = line({ type: "extension_ui_request", id: "1", method: "confirm", title: "t", message: "m" });
  pending.noteStdout(confirm);
  pending.noteStdin(`${line({ type: "host_tool_result", id: "1", result: { content: [] } })}\n`);
  assert.deepEqual(pending.lines(), [confirm]);
  pending.noteStdout(line({ type: "ui_end", id: "1" }));
  assert.deepEqual(pending.lines(), []);
});

test("get_state response and session frames name the child's session", () => {
  const A = "11111111-2222-4333-8444-00000000000a";
  const B = "11111111-2222-4333-8444-00000000000b";
  const pending = new PendingRequests(LIMIT, A);
  assert.equal(pending.sessionId, A);
  pending.noteStdout(line({ type: "response", id: "2", command: "get_state", success: true, data: { sessionId: B } }));
  assert.equal(pending.sessionId, B);
  assert.deepEqual(pending.lines(), [], "identity is not an open request");
  pending.noteStdout(line({ type: "session", sessionId: "not-a-session", sessionFile: "", cwd: "/" }));
  assert.equal(pending.sessionId, null, "an id main could not adopt names no session");
});

test("past limitBytes lines() is null until the oversized request closes", () => {
  const pending = new PendingRequests(1000);
  pending.noteStdout(line({ type: "extension_ui_request", id: "1", method: "input", title: "t" }));
  pending.noteStdout(line({ type: "extension_ui_request", id: "2", method: "input", title: "x".repeat(2000) }));
  assert.equal(pending.lines(), null);
  pending.noteStdin(line({ type: "extension_ui_response", id: "2", value: "v" }));
  assert.equal(pending.lines().length, 1);
});

test("a closed request frees its bytes: answered traffic past limitBytes leaves later requests adoptable", () => {
  const pending = new PendingRequests(1000);
  for (let i = 0; i < 10; i++) {
    pending.noteStdout(line({ type: "host_tool_call", id: String(i), toolName: "browser", arguments: { pad: "x".repeat(300) } }));
    pending.noteStdin(line({ type: "host_tool_result", id: String(i), result: { content: [] } }));
  }
  const open = line({ type: "host_tool_call", id: "99", toolName: "browser", arguments: { pad: "x".repeat(300) } });
  pending.noteStdout(open);
  assert.deepEqual(pending.lines(), [open]);
});

test("presentation frames and garbage lines are not kept", () => {
  const pending = new PendingRequests(LIMIT);
  pending.noteStdout(line({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" }));
  pending.noteStdout("not json host_tool_call");
  pending.noteStdout('{"type":"extension_ui_request"');
  assert.deepEqual(pending.lines(), []);
});

test("turn events track activity, not a count of repeated starts and ends", () => {
  const pending = new PendingRequests(LIMIT);
  assert.equal(pending.activeTurn, false, "an idle child is not an executing turn");
  pending.noteStdout(event({ type: "agent_start" }));
  pending.noteStdout(event({ type: "agent_start" }));
  assert.equal(pending.activeTurn, true);
  pending.noteStdout(event({ type: "agent_end" }));
  assert.equal(pending.activeTurn, false);
});
