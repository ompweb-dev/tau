import assert from "node:assert/strict";
import test from "node:test";
import { SubagentBridge } from "./subagent-bridge.ts";
import { parseSubagentLifecycle, parseSubagentProgress, parseSubagentSnapshot } from "../subagent-types.ts";

const row = (status, extra = {}) => ({ index: 0, agent: "reviewer", status, task: "Review the diff", sessionFile: "/s/child.jsonl", recentTools: [], recentOutput: [], toolCount: 2, tokens: 10, currentTool: "read", model: "anthropic/claude", ...extra });
const update = (toolCallId, rows) => ({ type: "tool_execution_update", toolCallId, toolName: "subagent", partialResult: { content: [], details: { progress: rows } } });
const end = (toolCallId, rows, isError = false) => ({ type: "tool_execution_end", toolCallId, toolName: "subagent", isError, result: { content: [], details: { progress: rows } } });
const kinds = (result) => result.frames.map((frame) => `${frame.type}:${frame.payload.status ?? frame.payload.progress?.status}`);

test("a foreground subagent call becomes a started child, its progress, and its end; the call frame still passes", () => {
  const bridge = new SubagentBridge();
  const first = bridge.translate(update("call|1", [row("running")]));
  assert.equal(first.consume, false);
  assert.deepEqual(kinds(first), ["subagent_lifecycle:started", "subagent_progress:running"], "lifecycle first: the roster ignores progress for a child it lacks");
  const info = parseSubagentLifecycle(first.frames[0].payload);
  assert.equal(info.id, "call_1.0", "an id tau can name a transcript file by");
  assert.equal(info.parentToolCallId, "call|1");
  assert.equal(info.sessionFile, "/s/child.jsonl");
  const progress = parseSubagentProgress(first.frames[1].payload.progress);
  assert.equal(progress.currentTool, "read");
  assert.equal(progress.resolvedModel, "anthropic/claude");
  assert.deepEqual(bridge.running().map((child) => child.id), ["call_1.0"]);

  assert.deepEqual(bridge.translate(update("call|1", [row("running")])).frames, [], "an unchanged report adds nothing");
  assert.deepEqual(kinds(bridge.translate(update("call|1", [row("running", { toolCount: 3 })]))), ["subagent_progress:running"]);
  assert.deepEqual(kinds(bridge.translate(end("call|1", [row("running", { toolCount: 3 })]))), ["subagent_progress:completed", "subagent_lifecycle:completed"], "a child still running when the call ends ends with it");
  assert.deepEqual(bridge.running(), []);
  assert.deepEqual(bridge.translate(update("call|1", [row("running")])).frames, [], "an ended child never comes back");
});

test("a failed call fails the children it left running", () => {
  const bridge = new SubagentBridge();
  bridge.translate(update("c", [row("running"), row("completed", { index: 1 })]));
  assert.deepEqual(kinds(bridge.translate(end("c", [row("running"), row("completed", { index: 1 })], true))), ["subagent_progress:failed", "subagent_lifecycle:failed"]);
});

test("a detached child stays live when its call ends: pi-subagents paused it, it did not finish", () => {
  const bridge = new SubagentBridge();
  bridge.translate(update("d", [row("running")]));
  assert.deepEqual(kinds(bridge.translate(end("d", [row("detached")]))), [], "no completed or failed frame");
  assert.deepEqual(bridge.running().map((child) => child.id), ["d.0"]);
});

test("background runs come from the subagent-async widget, which tau consumes", () => {
  const bridge = new SubagentBridge();
  const widget = (runs) => ({ type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "subagent-async", widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: "pi-subagents.async-status-snapshot", version: 1, runs })}`] });
  const run = (state, children = []) => ({ id: "run-1", kind: "workflow", label: "sweep", state, startedAt: 1000, updatedAt: 3000, children });
  const step = (state) => ({ id: "step:0", kind: "step", label: "lint", state, agent: "linter", model: "m", activity: { currentTool: "bash", toolCount: 4 } });
  const first = bridge.translate(widget([run("running", [step("running")])]));
  assert.equal(first.consume, true);
  assert.deepEqual(kinds(first), ["subagent_lifecycle:started", "subagent_progress:running", "subagent_lifecycle:started", "subagent_progress:running"]);
  const child = parseSubagentLifecycle(first.frames[2].payload);
  assert.deepEqual([child.id, child.agent, child.detached], ["async.step_0", "linter", true]);
  assert.deepEqual(bridge.running().map((entry) => parseSubagentSnapshot(entry)?.id), ["async.run-1", "async.step_0"]);
  assert.deepEqual(kinds(bridge.translate(widget([run("failed", [step("stopped")])]))), ["subagent_progress:failed", "subagent_lifecycle:failed", "subagent_progress:aborted", "subagent_lifecycle:aborted"]);
  assert.deepEqual(bridge.translate({ type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "subagent-async" }), { frames: [], consume: true }, "a cleared widget");
  assert.equal(bridge.translate({ type: "agent_start" }), null);
});
