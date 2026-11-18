import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";
import { PassThrough } from "node:stream";

// Each test that mocks child_process imports omp-cli fresh so it binds the fake.
let freshImport = 0;
const { RpcProcess, resolveTauExtensionPath } = await import("./rpc-process.ts");
// pi takes its cwd from the spawn options, not an argument.
const extension = resolveTauExtensionPath();
const PI_ARGS = ["--mode", "rpc", ...(extension ? ["--extension", extension] : [])];

/** Replace process.platform for the duration of one test (helper reads it at call time). */
function withPlatform(t, platform) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", { value: original }));
}

/** Minimal fake child matching RpcProcess's constructor wiring (repo makeTransport shape). */
function makeSpawnHarness() {
  const spawnCalls = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4321,
  });
  return {
    spawnCalls,
    spawn(file, args, opts) {
      spawnCalls.push({ file, args, opts });
      return child;
    },
  };
}

function startProcess(bin, cwd, extraArgs = []) {
  const harness = makeSpawnHarness();
  const proc = new RpcProcess({
    cwd,
    extraArgs,
    dependencies: { resolveOmpBin: () => bin, spawn: harness.spawn },
  });
  return { proc, harness };
}

const CWD = mkdtempSync(join(tmpdir(), "omp-winspawn-"));

test("RpcProcess routes .cmd launchers through cmd.exe on win32", (t) => {
  withPlatform(t, "win32");
  const { harness } = startProcess("C:\\tools\\omp-work.cmd", CWD);
  assert.equal(harness.spawnCalls.length, 1);
  assert.equal(harness.spawnCalls[0].file, "cmd.exe");
  assert.deepEqual(harness.spawnCalls[0].args, ["/c", "C:\\tools\\omp-work.cmd", ...PI_ARGS]);
});

test("RpcProcess routes .bat launchers through cmd.exe on win32", (t) => {
  withPlatform(t, "win32");
  const { harness } = startProcess("C:\\tools\\omp-work.bat", CWD);
  assert.equal(harness.spawnCalls[0].file, "cmd.exe");
  assert.deepEqual(harness.spawnCalls[0].args, ["/c", "C:\\tools\\omp-work.bat", ...PI_ARGS]);
});

test("RpcProcess matches script extensions case-insensitively", (t) => {
  withPlatform(t, "win32");
  const { harness } = startProcess("C:\\tools\\OMP-WORK.CMD", CWD);
  assert.equal(harness.spawnCalls[0].file, "cmd.exe");
  assert.deepEqual(harness.spawnCalls[0].args, ["/c", "C:\\tools\\OMP-WORK.CMD", ...PI_ARGS]);
});

test("RpcProcess leaves .exe binaries untouched", () => {
  const { harness } = startProcess("C:\\tools\\omp.exe", CWD);
  assert.equal(harness.spawnCalls[0].file, "C:\\tools\\omp.exe");
  assert.deepEqual(harness.spawnCalls[0].args, [...PI_ARGS]);
});

test("RpcProcess leaves extensionless binaries untouched", () => {
  const { harness } = startProcess("omp", CWD);
  assert.equal(harness.spawnCalls[0].file, "omp");
  assert.deepEqual(harness.spawnCalls[0].args, [...PI_ARGS]);
});

test("RpcProcess never wraps .cmd on non-win32 platforms", (t) => {
  withPlatform(t, "linux");
  const { harness } = startProcess("/usr/local/bin/omp-work.cmd", CWD);
  assert.equal(harness.spawnCalls[0].file, "/usr/local/bin/omp-work.cmd");
  assert.deepEqual(harness.spawnCalls[0].args, [...PI_ARGS]);
});

test("production launcher produces the exact Phase 5.3 spawn shape with options unchanged", (t) => {
  withPlatform(t, "win32");
  const launcher = "C:\\Users\\ChristianStarcke\\.local\\bin\\omp-work.cmd";
  const { harness } = startProcess(launcher, CWD);
  const call = harness.spawnCalls[0];
  assert.equal(call.file, "cmd.exe");
  assert.deepEqual(call.args, ["/c", launcher, ...PI_ARGS]);
  // Everything except (file, args) must be byte-for-byte what the unwrapped
  // spawn produced before the patch.
  assert.equal(call.opts.cwd, CWD);
  assert.equal(call.opts.windowsHide, true);
  assert.equal(call.opts.detached, false);
  assert.deepEqual(call.opts.stdio, ["pipe", "pipe", "pipe"]);
  assert.ok(call.opts.env && typeof call.opts.env === "object");
});

test("probeOmpVersion routes .cmd launchers through cmd.exe on win32", async (t) => {
  withPlatform(t, "win32");
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.TAU_PI_BIN;
  process.env.TAU_PI_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.TAU_PI_BIN;
    else process.env.TAU_PI_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  let captured = null;
  await mockBuiltin(t, "node:child_process", { execFile: (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  } });
  const { getOmpVersion } = await import(`./omp-cli.ts?fresh=${freshImport++}`);
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(captured.file, "cmd.exe");
  assert.deepEqual(captured.args, ["/c", bin, "--version"]);
  assert.equal(captured.options.windowsHide, true);
});

test("probeOmpVersion leaves .exe binaries untouched", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp.exe");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.TAU_PI_BIN;
  process.env.TAU_PI_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.TAU_PI_BIN;
    else process.env.TAU_PI_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  let captured = null;
  await mockBuiltin(t, "node:child_process", { execFile: (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  } });
  const { getOmpVersion } = await import(`./omp-cli.ts?fresh=${freshImport++}`);
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(captured.file, bin);
  assert.deepEqual(captured.args, ["--version"]);
});

test("probeOmpVersion never wraps .cmd on non-win32 platforms", async (t) => {
  withPlatform(t, "linux");
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-"));
  const bin = join(dir, "omp-work.cmd");
  writeFileSync(bin, "stub\n");
  const previousBin = process.env.TAU_PI_BIN;
  process.env.TAU_PI_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.TAU_PI_BIN;
    else process.env.TAU_PI_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });
  let captured = null;
  await mockBuiltin(t, "node:child_process", { execFile: (file, args, options, callback) => {
    captured = { file, args, options };
    queueMicrotask(() => callback(null, "omp/18.2.4\n"));
  } });
  const { getOmpVersion } = await import(`./omp-cli.ts?fresh=${freshImport++}`);
  assert.equal(await getOmpVersion(), "omp/18.2.4");
  assert.equal(captured.file, bin);
  assert.deepEqual(captured.args, ["--version"]);
});

test("real .cmd launcher through the real spawn path receives spaced arguments intact", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-real-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake-omp.cmd");
  const argsFile = join(dir, "args.txt");
  // The engine stub announces readiness like omp, then records its raw argument
  // tail so the test can pin cmd.exe quoting of the spaced --session argument.
  writeFileSync(bin, [
    "@echo off",
    "echo {\"t\":\"hello\",\"proto\":1}",
    "> \"%~dp0args.txt\" echo %*",
    "",
  ].join("\r\n"));
  // The spawn cwd contains a literal space, so the --session file path the
  // launcher passes does too.
  const spacedCwd = join(dir, "temp dir x");
  mkdirSync(spacedCwd);

  const previousExtension = process.env.TAU_NO_EXTENSION;
  process.env.TAU_NO_EXTENSION = "1";
  t.after(() => {
    if (previousExtension === undefined) delete process.env.TAU_NO_EXTENSION;
    else process.env.TAU_NO_EXTENSION = previousExtension;
  });
  const sessionFile = join(spacedCwd, "s.jsonl");
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers();
  new RpcProcess({
    cwd: spacedCwd,
    extraArgs: ["--session", sessionFile],
    dependencies: { resolveOmpBin: () => bin }, // real child_process.spawn — no seam
    onExit: (info) => resolveExit(info),
  });
  // The stub exits quickly; asserting the exit code and the recorded argument
  // tail (which proves stdio + cmd.exe quoting end to end) is deterministic,
  // unlike racing the ready frame against the exit event.
  const info = await exited;
  assert.equal(info.code, 0);
  const rawTail = readFileSync(argsFile, "utf8").replace(/\r\n/g, "\n").trim();
  assert.equal(rawTail, `--mode rpc --session "${sessionFile}"`);
});

test("real .cmd launcher through the real version probe returns its stdout", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-winspawn-probe-real-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fake-omp.cmd");
  const argsFile = join(dir, "probe-args.txt");
  writeFileSync(bin, [
    "@echo off",
    "> \"%~dp0probe-args.txt\" echo %*",
    "echo omp/99.9.9-win",
    "",
  ].join("\r\n"));
  const previousBin = process.env.TAU_PI_BIN;
  process.env.TAU_PI_BIN = bin;
  t.after(() => {
    if (previousBin === undefined) delete process.env.TAU_PI_BIN;
    else process.env.TAU_PI_BIN = previousBin;
  });
  const { getOmpVersion } = await import(`./omp-cli.ts?fresh=${freshImport++}`);
  assert.equal(await getOmpVersion(), "omp/99.9.9-win");
  const rawArgs = readFileSync(argsFile, "utf8").replace(/\r\n/g, "\n").trim();
  assert.equal(rawArgs, "--version");
});
