import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { localHost, buildSessionSpawnArgs } = await import("./local-host.ts");

test("the owning host refuses legacy configuration before starting omp", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tau-launch-config-"));
  const agentDir = join(root, "agent");
  const cwd = realpathSync(root);
  mkdirSync(agentDir);
  const marker = join(root, "spawned");
  const bin = join(root, process.platform === "win32" ? "omp.cmd" : "omp");
  if (process.platform === "win32") writeFileSync(bin, `@echo spawned > "${marker}"\r\n`);
  else writeFileSync(bin, `#!/bin/sh\necho spawned > '${marker}'\n`, { mode: 0o755 });
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldBin = process.env.TAU_PI_BIN;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TAU_PI_BIN = bin;
  t.after(() => {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldBin === undefined) delete process.env.TAU_PI_BIN; else process.env.TAU_PI_BIN = oldBin;
    rmSync(root, { recursive: true, force: true });
  });
  for (const [launchConfig, code] of [
    [{ extraArgs: ["--fork", "/elsewhere"] }, "stored_reserved_launch_arg"],
    [{ extraArgs: ["--resume=/tmp/other"] }, "stored_reserved_launch_arg"],
    [{ extraArgs: ["--session=/tmp/other"] }, "stored_reserved_launch_arg"],
    [{ extraArgs: ["--mode", "json"] }, "stored_reserved_launch_arg"],
  ]) {
    writeFileSync(join(agentDir, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: cwd, addedAt: "2026-01-01", hidden: false, launchConfig }] }));
    await assert.rejects(localHost.spawnRpc({ cwd, recordedCwd: cwd, sessionFile: "" }), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, code);
      assert.match(error.message, /workspace launch configuration/i);
      return true;
    });
    assert.equal(existsSync(marker), false);
  }
  // pi has no profiles: a legacy stored profile is never passed on.
  assert.deepEqual(buildSessionSpawnArgs("", undefined, { profile: "work", extraArgs: ["--verbose"] }), ["--verbose"]);
});

test("the agentEnv setting reaches the spawned child", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "tau-launch-env-"));
  const agentDir = join(root, "agent");
  const cwd = realpathSync(root);
  const seen = join(root, "seen");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "tau-settings.json"), JSON.stringify({ agentEnv: { AGENT_TEST_VALUE: "from-settings" } }));
  const bin = join(root, process.platform === "win32" ? "omp.cmd" : "omp");
  if (process.platform === "win32") writeFileSync(bin, `@echo %AGENT_TEST_VALUE%> "${seen}"\r\n`);
  else writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$AGENT_TEST_VALUE" > '${seen}'\n`, { mode: 0o755 });
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldBin = process.env.TAU_PI_BIN;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TAU_PI_BIN = bin;
  t.after(() => {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldBin === undefined) delete process.env.TAU_PI_BIN; else process.env.TAU_PI_BIN = oldBin;
    rmSync(root, { recursive: true, force: true });
  });
  const request = { cwd, recordedCwd: cwd, sessionFile: "" };
  const run = async () => {
    const { transport } = await localHost.spawnRpc(request);
    await new Promise((resolve) => transport.onExit(resolve));
    return readFileSync(seen, "utf8").trim();
  };
  assert.equal(await run(), "from-settings");
});
