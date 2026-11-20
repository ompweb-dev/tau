import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const { setSessionTitle } = await import("./session-files.ts");
const { resolvePiBin, wrapWindowsScript } = await import("./pi-cli.ts");

const piBin = resolvePiBin();

/** Open `sessionFile` in a real `pi --mode rpc` and answer `get_state` and `get_messages`. */
async function readWithPi(agentDir, cwd, sessionFile) {
  // Windows' npm launcher is pi.cmd, which spawn cannot run without cmd.exe.
  const { file, args } = wrapWindowsScript(piBin, ["--mode", "rpc", "--session", sessionFile, "--offline", "--no-extensions", "--no-skills", "--no-mcp", "--no-approve"]);
  const child = spawn(file, args, {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = new Map();
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.type !== "response" || !frame.id) return;
    replies.set(frame.id, frame);
    waiting.get(frame.id)?.(frame);
  });
  const ask = (id, type) => new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, type })}\n`);
    if (replies.has(id)) resolve(replies.get(id));
  });
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("pi did not answer")), 20_000));
    const state = await Promise.race([ask("state", "get_state"), timeout]);
    const messages = await Promise.race([ask("messages", "get_messages"), timeout]);
    return { state: state.data, messages: messages.data.messages };
  } finally {
    child.kill();
  }
}

test("pi resumes a session tau renamed, with its messages and the new name", { skip: !piBin && "pi is not installed", timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "tau-pi-name-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    const sessionFile = join(root, "2026-01-01T00-00-00-000Z_11111111-2222-4333-8444-555555555555.jsonl");
    const records = [
      { type: "session", version: 3, id: "11111111-2222-4333-8444-555555555555", timestamp: "2026-01-01T00:00:00.000Z", cwd },
      { type: "message", id: "aaaaaaaa", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello pi", timestamp: 1 } },
      { type: "message", id: "bbbbbbbb", parentId: "aaaaaaaa", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello tau" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
    ];
    writeFileSync(sessionFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    assert.equal(setSessionTitle(sessionFile, "Renamed by tau"), true);
    const { state, messages } = await readWithPi(agentDir, cwd, sessionFile);
    assert.equal(state.sessionName, "Renamed by tau");
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
