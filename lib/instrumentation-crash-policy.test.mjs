import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const readOrEmpty = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// Runs instrumentation.node.ts's register() in a child, then `then`. Returns
// the exit status plus the journal under the agent dir and the old ~/.pi/tau location.
function runAfterRegister(then, { agentDir = "agent" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "tau-crash-policy-"));
  try {
    const script = `
      const { register } = await import(${JSON.stringify(join(root, "instrumentation.node.ts"))});
      await register();
      ${then}
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, agentDir),
        TAU_PI_BIN: join(home, "missing-pi"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      journal: readOrEmpty(join(home, agentDir, "tau", "diagnostics.log")),
      homeJournal: readOrEmpty(join(home, ".pi", "tau", "diagnostics.log")),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Throws `error` uncaught after register(); status 0 = kept serving.
const throwAfterRegister = (errorExpr, options) => runAfterRegister(`
  setTimeout(() => { throw ${errorExpr}; }, 0);
  setTimeout(() => process.exit(0), 300);
`, options);

// Windows has no signals: process.kill(pid, "SIGINT") terminates the process outright (status 1), so no handler runs.
test("SIGINT and SIGTERM end the server even though modules listen for them", { skip: process.platform === "win32" && "Windows kills on SIGINT/SIGTERM without running handlers" }, () => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    // The first listener stands in for a module's cleanup (lib/rpc-manager.ts),
    // which on its own cancels the default exit.
    const { status, stderr } = runAfterRegister(`
      process.once("${signal}", () => {});
      process.kill(process.pid, "${signal}");
      setTimeout(() => process.exit(0), 2000);
    `);
    assert.equal(status, code, `${signal}\n${stderr}`);
  }
});

test("a client disconnect surfacing as uncaught `aborted` is journaled without exiting", () => {
  const { status, journal, stderr } = throwAfterRegister(`Object.assign(new Error("aborted"), { code: "ECONNRESET" })`);
  assert.equal(status, 0, stderr);
  assert.match(journal, /\[client-abort\] uncaughtException Error: aborted/);
  assert.doesNotMatch(journal, /\[crash\]/);
});

test("the journal lives in <agent dir>/tau, the default agent dir included", () => {
  for (const agentDir of ["agent", join(".pi", "agent")]) {
    const { journal, homeJournal } = throwAfterRegister(`new Error("boom")`, { agentDir });
    assert.match(journal, /\[crash\] uncaughtException Error: boom/);
    assert.equal(homeJournal, "", "nothing is written to ~/.pi/tau");
  }
});

test("any other uncaught exception still exits with code 2", () => {
  for (const errorExpr of [
    `new Error("boom")`,
    `Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })`,
    `Object.assign(new Error("aborted by peer"), { code: "ECONNRESET" })`,
    `Object.assign(new Error("aborted"), { code: "ERR_OTHER" })`,
    `null`,
    `undefined`,
  ]) {
    const { status, journal, stderr } = throwAfterRegister(errorExpr);
    assert.equal(status, 2, `${errorExpr}\n${stderr}`);
    assert.match(journal, /\[crash\] uncaughtException/, errorExpr);
  }
});
