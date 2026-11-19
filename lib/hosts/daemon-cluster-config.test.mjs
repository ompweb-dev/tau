import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";
import { mock } from "bun:test";

// Fault injection: every renameSync passes `renameHook` first, and while `dead` (a crash) every write to the disk fails.
// Bun patches the live namespace in place, so the wrapper calls a copy of the real module; "fs" (web-settings) and
// "node:fs" are separate mock keys.
const realFs = { ...(await import("node:fs")) };
let renameHook = null;
let dead = false;
const alive = () => {
  if (dead) throw Object.assign(new Error("injected crash"), { code: "EIO" });
};
const mockedFs = () => ({
  ...realFs,
  renameSync(from, to) {
    alive();
    renameHook?.(String(from), String(to));
    return realFs.renameSync(from, to);
  },
  ...Object.fromEntries(
    ["rmSync", "rmdirSync", "mkdirSync", "writeFileSync", "chmodSync"].map((name) => [
      name,
      (...args) => {
        alive();
        return realFs[name](...args);
      },
    ]),
  ),
});
for (const name of ["fs", "node:fs"]) mock.module(name, mockedFs);

const { buildManifest } = await import("./cluster-config.ts");
const { clusterConfigTimings, createClusterConfig } = await import("./daemon-cluster-config.ts");
const { loadWebServerSettings, saveWebServerSettings } = await import("../web-settings.ts");

const MASTER = "https://master.test";
const MANIFEST = "/api/hosts/cluster-config/manifest";
const FILE = "/api/hosts/cluster-config/file/";
const EMPTY = { version: null, files: "none", error: null, missingCommands: [] };
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

let base;
let roots;
let master;
let stateDir;
let own;
beforeEach(() => {
  dead = false;
  base = realpathSync(mkdtempSync(join(tmpdir(), "tau-member-config-test-")));
  roots = { agent: join(base, "member", "agent"), home: join(base, "member", "home") };
  master = { agent: join(base, "master", "agent"), home: join(base, "master", "home") };
  for (const dir of [...Object.values(roots), ...Object.values(master)]) mkdirSync(dir, { recursive: true });
  stateDir = join(roots.agent, "tau");
  own = join(stateDir, "own-config");
  // web-settings resolves tau-settings.json in the agent directory.
  process.env.PI_CODING_AGENT_DIR = roots.agent;
  renameHook = null;
});
afterEach(() => {
  dead = false;
  renameHook = null;
  rmSync(base, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = (path) => lstatSync(path).mode & 0o777;
// Unix permission bits: Windows has none to assert (a stat reports 0666, or 0444 when read-only).
const POSIX = process.platform !== "win32";
const read = (path) => readFileSync(path, "utf8");

function put(root, path, content = "x", fileMode = 0o644) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, fileMode);
  return file;
}

/** Every entry under both member roots (tau's own state excluded): type, mode, bytes or link target. */
function tree() {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === roots.agent && name === "tau") continue;
      const path = join(dir, name);
      const key = `${rel}/${name}`;
      const stat = lstatSync(path);
      const bits = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = `dir ${bits}`;
        walk(path, key);
      } else out[key] = `file ${bits} ${readFileSync(path).toString("base64")}`;
    }
  };
  walk(roots.agent, "agent");
  walk(roots.home, "home");
  return out;
}

function memberSetup() {
  put(roots.agent, "settings.json", JSON.stringify({ shellPath: "/member/bash", modelRoles: { default: "member-model" } }) + "\n", 0o640);
  put(roots.agent, "models.json", '{"providers":{"member":{}}}\n', 0o600);
  put(roots.agent, "mcp.json", '{"mcpServers":{}}\n');
  put(roots.agent, "AGENTS.md", "member rules\n", 0o640);
  put(roots.agent, "skills/mine/SKILL.md", "member skill\n");
  chmodSync(join(roots.agent, "skills"), 0o755);
  put(roots.agent, "sessions/s.jsonl", "{}\n");
  put(roots.home, ".agents/skills/home-skill/SKILL.md", "home skill\n");
  saveWebServerSettings({ agentEnv: { MEMBER_ONLY: "1" } });
}

function masterBuild({ rules = "master rules\n", agentEnv = { CLUSTER_KEY: "c" } } = {}) {
  put(master.agent, "settings.json", JSON.stringify({ shellPath: "/master/zsh", modelRoles: { default: "master-model" } }) + "\n");
  put(master.agent, "models.json", '{"providers":{}}\n');
  put(master.agent, "mcp.json", JSON.stringify({ mcpServers: { tool: { command: "present-cmd" }, other: { command: "absent-cmd" }, web: { url: "https://x.test" } } }));
  put(master.agent, "AGENTS.md", rules);
  put(master.agent, "skills/shared/SKILL.md", "shared skill\n");
  put(master.agent, "skills/shared/scripts/deep/run.sh", "#!/bin/sh\necho hi\n", 0o755);
  put(master.home, ".agents/skills/remote/SKILL.md", "remote skill\n");
  return buildManifest(master, { agentEnv });
}

/** A master's two routes at `url`; `current` is the bundle served, `gate` holds the manifest answer back. */
function serve(build, url = MASTER) {
  const srv = { current: build, calls: [], gate: null, onFile: null };
  srv.fetch = async (serverUrl, path) => {
    assert.equal(serverUrl, url);
    srv.calls.push(path);
    if (path === MANIFEST) {
      if (srv.gate) await srv.gate;
      return Response.json(srv.current.manifest);
    }
    assert.ok(path.startsWith(FILE), path);
    const hash = path.slice(FILE.length);
    const special = srv.onFile?.(hash);
    if (special) return special;
    const bytes = srv.current.content(hash);
    return bytes ? new Response(bytes) : Response.json({ error: "Not found" }, { status: 404 });
  };
  return srv;
}

/** `linked`: the servers this daemon links to (null: every one). */
function member(srv, available = new Set(["present-cmd"]), linked = null) {
  const logs = [];
  const states = [];
  const config = createClusterConfig({
    roots: () => roots,
    stateDir: () => stateDir,
    fetch: srv.fetch,
    commandExists: async (command) => available.has(command),
    onState: (state) => states.push(state),
    isLinked: (url) => linked?.has(url) ?? true,
    log: (message) => logs.push(message),
  });
  return { config, logs, states };
}

/** Waits for the MCP command check queued after an apply: every masterBuild names `absent-cmd`, which members lack. */
async function checked(config) {
  for (let i = 0; i < 400 && config.state().missingCommands.length === 0; i++) await sleep(5);
  assert.deepEqual(config.state().missingCommands, ["absent-cmd"]);
}

const rejectsConfig = (promise, pattern) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.name, "HostOpError");
    assert.equal(error.status, 409);
    assert.equal(error.code, "cluster_config_failed");
    if (pattern) assert.match(error.message, pattern);
    return true;
  });

/** Fails the `n`-th move of a staged entry into the live tree. */
function failAtSwap(n) {
  const stage = join(stateDir, "cluster-config", "stage");
  let count = 0;
  renameHook = (from, to) => {
    if (from.startsWith(`${stage}${sep}`) && !to.startsWith(`${stateDir}${sep}`) && ++count === n) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
  };
}

/** The process dies at the `n`-th move of a staged entry into the live tree: from there on nothing reaches the disk. */
function crashAtSwap(n) {
  const stage = join(stateDir, "cluster-config", "stage");
  let count = 0;
  renameHook = (from, to) => {
    if (from.startsWith(`${stage}${sep}`) && !to.startsWith(`${stateDir}${sep}`) && ++count === n) {
      dead = true;
      alive();
    }
  };
}

/** Holds the manifest answer of `srv` until the returned function is called. */
function hold(srv) {
  let release;
  srv.gate = new Promise((resolve) => (release = resolve));
  return release;
}

async function firstApply(options) {
  memberSetup();
  const build = masterBuild(options);
  const srv = serve(build);
  const m = member(srv);
  await m.config.ensure(build.manifest.version, MASTER);
  return { ...m, build, srv };
}

test("first apply writes the master's files privately, creates nested directories and backs up the member's own", async () => {
  memberSetup();
  const build = masterBuild();
  const { config } = member(serve(build));
  await config.ensure(build.manifest.version, MASTER);

  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n");
  if (POSIX) {
    assert.equal(mode(join(roots.agent, "AGENTS.md")), 0o600);
    assert.equal(mode(join(roots.agent, "skills/shared/scripts/deep/run.sh")), 0o700);
    assert.equal(mode(join(roots.agent, "skills/shared/scripts/deep")), 0o700);
  }
  assert.equal(read(join(roots.home, ".agents/skills/remote/SKILL.md")), "remote skill\n");
  assert.equal(read(join(roots.agent, "sessions/s.jsonl")), "{}\n", "an entry that is not mirrored is left alone");

  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  if (POSIX) assert.equal(mode(join(own, "agent/AGENTS.md")), 0o640);
  assert.equal(read(join(own, "home/.agents/skills/home-skill/SKILL.md")), "home skill\n");
  assert.deepEqual(JSON.parse(read(join(own, "agent-env.json"))), { MEMBER_ONLY: "1" });

  const state = config.state();
  assert.equal(state.version, build.manifest.version);
  assert.equal(state.files, "current");
  assert.equal(state.error, null);
});

test("a member file inside a mirrored directory the master lacks leaves the live tree for the backup", async () => {
  await firstApply();
  assert.equal(existsSync(join(roots.agent, "skills/mine")), false);
  assert.equal(existsSync(join(roots.home, ".agents/skills/home-skill")), false);
  assert.equal(read(join(own, "agent/skills/mine/SKILL.md")), "member skill\n");
});

test("settings.json keeps the member's shellPath and takes the master's other keys", async () => {
  await firstApply();
  const settings = JSON.parse(read(join(roots.agent, "settings.json")));
  assert.equal(settings.shellPath, "/member/bash");
  assert.equal(settings.modelRoles.default, "master-model");
});

test("agentEnv in the member's tau-settings.json equals the manifest's", async () => {
  const { build } = await firstApply();
  assert.deepEqual(JSON.parse(read(join(roots.agent, "tau-settings.json"))).agentEnv, build.manifest.agentEnv);
  assert.deepEqual(loadWebServerSettings().agentEnv, build.manifest.agentEnv);
});

test("ensure with the applied version fetches nothing", async () => {
  const { config, build, srv } = await firstApply();
  const calls = srv.calls.length;
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(srv.calls.length, calls);
});

test("two concurrent ensure calls share one apply", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = serve(build);
  const { config } = member(srv);
  await Promise.all([config.ensure(build.manifest.version, MASTER), config.ensure(build.manifest.version, MASTER)]);
  assert.equal(srv.calls.filter((path) => path === MANIFEST).length, 1);
  assert.equal(config.state().files, "current");
});

test("a manifest path outside the mirrored entries rejects the version before anything is written", async () => {
  memberSetup();
  const build = masterBuild();
  const before = tree();
  for (const bad of [
    { root: "agent", path: "../x" },
    { root: "agent", path: "sessions/a" },
  ]) {
    const file = build.manifest.files[0];
    const srv = serve({ manifest: { ...build.manifest, files: [...build.manifest.files, { ...file, ...bad }] }, content: build.content });
    const { config } = member(srv);
    await rejectsConfig(config.ensure(build.manifest.version, MASTER));
    assert.deepEqual(srv.calls, [MANIFEST], "no file is downloaded");
    assert.deepEqual(tree(), before);
    assert.equal(existsSync(own), false);
    assert.equal(existsSync(join(stateDir, "cluster-config", "objects")), false);
    assert.equal(config.state().files, "failed");
  }
});

test("a downloaded file whose hash does not match is rejected and never stored", async () => {
  memberSetup();
  const build = masterBuild();
  const agents = build.manifest.files.find((file) => file.path === "AGENTS.md");
  const srv = serve(build);
  srv.onFile = (hash) => (hash === agents.hash ? new Response("master rulez\n") : null);
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /AGENTS\.md/);
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(join(stateDir, "cluster-config", "objects", agents.hash)), false);
  assert.equal(existsSync(own), false);
});

test("a body longer than the manifest's size is refused", async () => {
  memberSetup();
  const build = masterBuild();
  const agents = build.manifest.files.find((file) => file.path === "AGENTS.md");
  const srv = serve(build);
  srv.onFile = (hash) => (hash === agents.hash ? new Response(`master rules\n${"y".repeat(100_000)}`) : null);
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /longer/);
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(join(stateDir, "cluster-config", "objects", agents.hash)), false);
});

test("a 404 for a file fetches the manifest again and applies the new version", async () => {
  memberSetup();
  const v1 = masterBuild();
  const v2 = masterBuild({ rules: "master rules v2\n" });
  const srv = serve(v1);
  srv.onFile = () => {
    srv.onFile = null;
    srv.current = v2;
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  const { config } = member(srv);
  await config.ensure(v1.manifest.version, MASTER);
  assert.equal(srv.calls.filter((path) => path === MANIFEST).length, 2);
  assert.equal(config.state().version, v2.manifest.version);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules v2\n");
});

test("a failure at the third swap of a later version leaves the live tree as it was", async () => {
  const { config, build: v1, srv } = await firstApply();
  srv.current = masterBuild({ rules: "master rules v2\n", agentEnv: { CLUSTER_KEY: "v2" } });
  const before = tree();
  failAtSwap(3);
  await rejectsConfig(config.ensure(srv.current.manifest.version, MASTER), /injected/);
  renameHook = null;
  assert.deepEqual(tree(), before);
  assert.deepEqual(loadWebServerSettings().agentEnv, v1.manifest.agentEnv);
  const state = config.state();
  assert.equal(state.files, "failed");
  assert.match(state.error, /injected/);
  assert.equal(state.version, v1.manifest.version);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n", "the backup is untouched");
  const restarted = member(srv);
  assert.equal(restarted.config.state().version, v1.manifest.version, "state.json is back");
  await restarted.config.stop();
});

test("a failure at the third swap of the first apply leaves the live tree as it was, without a backup", async () => {
  memberSetup();
  const build = masterBuild();
  const { config } = member(serve(build));
  const before = tree();
  failAtSwap(3);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /injected/);
  renameHook = null;
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(own), false);
  assert.equal(config.state().files, "failed");
  assert.equal(config.state().version, null);

  await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n", "the retry backs up the member's own files");
  assert.equal(config.state().files, "current");
  assert.equal(config.state().error, null);
});

test("a failure writing state.json undoes the swaps and the agent environment", async () => {
  memberSetup();
  const build = masterBuild();
  const { config } = member(serve(build));
  const before = tree();
  renameHook = (from, to) => {
    if (to === join(stateDir, "cluster-config", "state.json")) throw Object.assign(new Error("injected state failure"), { code: "EIO" });
  };
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /injected/);
  renameHook = null;
  assert.deepEqual(tree(), before);
  assert.deepEqual(loadWebServerSettings().agentEnv, { MEMBER_ONLY: "1" });
  assert.equal(existsSync(own), false);
});

test("a second version keeps the first backup", async () => {
  const { config, srv } = await firstApply();
  srv.current = masterBuild({ rules: "master rules v2\n" });
  await config.ensure(srv.current.manifest.version, MASTER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules v2\n");
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(read(join(own, "agent/skills/mine/SKILL.md")), "member skill\n");
  assert.equal(JSON.parse(read(join(roots.agent, "settings.json"))).shellPath, "/member/bash");
  assert.equal(existsSync(join(stateDir, "cluster-config", "trash")), false);
});

test("symbolic links at managed paths move to the backup as links and nothing is written through them", async () => {
  memberSetup();
  const outside = join(base, "outside");
  put(outside, "target.md", "outside\n");
  put(outside, "skills/x/SKILL.md", "outside skill\n");
  rmSync(join(roots.agent, "AGENTS.md"));
  symlinkSync(join(outside, "target.md"), join(roots.agent, "AGENTS.md"));
  rmSync(join(roots.agent, "skills"), { recursive: true });
  symlinkSync(join(outside, "skills"), join(roots.agent, "skills"));
  put(roots.agent, "prompts/own.md", "own prompt\n");
  symlinkSync(join(outside, "target.md"), join(roots.agent, "prompts/link.md"));
  const original = tree();

  const build = masterBuild();
  const { config } = member(serve(build));
  await config.ensure(build.manifest.version, MASTER);

  assert.equal(read(join(outside, "target.md")), "outside\n");
  assert.deepEqual(readdirSync(join(outside, "skills")), ["x"]);
  assert.equal(read(join(outside, "skills/x/SKILL.md")), "outside skill\n");
  assert.ok(lstatSync(join(roots.agent, "AGENTS.md")).isFile());
  assert.ok(lstatSync(join(roots.agent, "skills")).isDirectory());
  assert.equal(readlinkSync(join(own, "agent/AGENTS.md")), join(outside, "target.md"));
  assert.equal(readlinkSync(join(own, "agent/skills")), join(outside, "skills"));
  assert.equal(readlinkSync(join(own, "agent/prompts/link.md")), join(outside, "target.md"));
  assert.equal(existsSync(join(roots.agent, "prompts")), false);

  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
  assert.equal(read(join(outside, "target.md")), "outside\n");
});

test("a member settings.json that is a relative symbolic link keeps its own settings at every apply, and the link comes back on leaving", async () => {
  memberSetup();
  rmSync(join(roots.agent, "settings.json"));
  put(base, "dotfiles/settings.json", JSON.stringify({ shellPath: "/member/bash", sessionDir: "/member/sessions" }) + "\n");
  symlinkSync("../../dotfiles/settings.json", join(roots.agent, "settings.json"));
  const original = tree();
  const srv = serve(masterBuild());
  const { config, logs } = member(srv);
  for (const rules of ["master rules\n", "master rules v2\n"]) {
    srv.current = masterBuild({ rules });
    await config.ensure(srv.current.manifest.version, MASTER);
    const settings = JSON.parse(read(join(roots.agent, "settings.json")));
    assert.deepEqual([settings.shellPath, settings.sessionDir, settings.modelRoles.default], ["/member/bash", "/member/sessions", "master-model"], rules);
  }
  if (POSIX) assert.equal(mode(join(own, "settings.json")), 0o600);
  assert.deepEqual(logs, []);
  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
  assert.equal(existsSync(own), false);
});

test("after a restart the applied version counts", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = serve(build);
  const before = member(srv);
  await before.config.ensure(build.manifest.version, MASTER);
  await before.config.stop();

  const { config } = member(srv);
  assert.equal(config.state().version, build.manifest.version);
  assert.equal(config.state().files, "current");
  const calls = srv.calls.length;
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(srv.calls.length, calls);
});

test("missingCommands lists the MCP command the member lacks, after ensure resolved, and again after a restart", async () => {
  const { config, srv } = await firstApply();
  await checked(config);
  await config.stop();
  await checked(member(srv).config);
});

test("restore puts the member's own configuration back byte for byte, modes included", async () => {
  memberSetup();
  put(roots.agent, "prompts/strict.md", "strict\n", 0o400);
  chmodSync(join(roots.agent, "prompts"), 0o750);
  const original = tree();
  const build = masterBuild();
  const { config, states } = member(serve(build));
  await config.ensure(build.manifest.version, MASTER);

  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
  assert.deepEqual(loadWebServerSettings().agentEnv, { MEMBER_ONLY: "1" });
  assert.deepEqual(config.state(), EMPTY);
  assert.deepEqual(states.at(-1), EMPTY);
  assert.equal(existsSync(own), false);
  assert.equal(existsSync(join(stateDir, "cluster-config")), false);

  await config.apply(build.manifest.version, MASTER);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n", "a later apply makes a fresh backup");
  await config.restore(MASTER);
  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
  assert.deepEqual(config.state(), EMPTY);
});

test("restore without a backup does nothing", async () => {
  memberSetup();
  const before = tree();
  const { config, states } = member(serve(masterBuild()));
  await config.restore(MASTER);
  assert.deepEqual(tree(), before);
  assert.deepEqual(states, []);
});

test("restore waits for an in-flight apply", async () => {
  memberSetup();
  const original = tree();
  const v1 = masterBuild();
  const srv = serve(v1);
  const { config } = member(srv);
  await config.ensure(v1.manifest.version, MASTER);

  srv.current = masterBuild({ rules: "master rules v2\n" });
  const release = hold(srv);
  const applying = config.ensure(srv.current.manifest.version, MASTER);
  let restored = false;
  const restoring = config.restore(MASTER).then(() => (restored = true));
  await sleep(30);
  assert.equal(restored, false);
  release();
  await applying;
  await restoring;

  assert.deepEqual(tree(), original);
  assert.deepEqual(config.state(), EMPTY);
});

test("a member's settings.json is backed up under its own name, its shellPath kept, and restored exactly", async () => {
  put(roots.agent, "settings.json", JSON.stringify({ shellPath: "/member/json-bash", theme: "dark" }) + "\n", 0o640);
  saveWebServerSettings({ agentEnv: {} });
  const original = tree();
  const build = masterBuild();
  const srv = serve(build);
  const { config } = member(srv);
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(JSON.parse(read(join(roots.agent, "settings.json"))).shellPath, "/member/json-bash");
  assert.equal(read(join(own, "agent/settings.json")), JSON.stringify({ shellPath: "/member/json-bash", theme: "dark" }) + "\n");

  srv.current = masterBuild({ rules: "master rules v2\n" });
  await config.ensure(srv.current.manifest.version, MASTER);
  assert.equal(JSON.parse(read(join(roots.agent, "settings.json"))).shellPath, "/member/json-bash", "later versions merge from the backed-up settings.json");

  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
});

test("an unparsable member settings.json keeps nothing of it and logs its path only", async () => {
  put(roots.agent, "settings.json", "{unclosed\n");
  const build = masterBuild();
  const { config, logs } = member(serve(build));
  await config.ensure(build.manifest.version, MASTER);
  const settings = JSON.parse(read(join(roots.agent, "settings.json")));
  assert.equal(settings.shellPath, undefined);
  assert.equal(settings.modelRoles.default, "master-model");
  const lines = logs.filter((line) => line.includes("settings.json"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(join(own, "agent", "settings.json")) || lines[0].includes(join(roots.agent, "settings.json")));
  assert.ok(!lines[0].includes("unclosed"));
});

test("a first apply whose rollback could not put files back is finished before the next apply", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild();
  const { config } = member(serve(build));
  failAtSwap(3);
  const swap = renameHook;
  renameHook = (from, to) => {
    if (from.startsWith(`${own}${sep}`) && !to.startsWith(`${stateDir}${sep}`)) throw Object.assign(new Error("injected undo failure"), { code: "EIO" });
    swap(from, to);
  };
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /injected rename failure/);
  renameHook = null;
  assert.notDeepEqual(tree(), original, "the rollback left files in the backup");

  await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(read(join(own, "agent/mcp.json")), '{"mcpServers":{}}\n');
  assert.equal(read(join(own, "agent/skills/mine/SKILL.md")), "member skill\n");
  assert.equal(JSON.parse(read(join(roots.agent, "settings.json"))).shellPath, "/member/bash");
  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
});

test("a restore that failed half-way is finished before the next version is applied", async () => {
  memberSetup();
  const original = tree();
  const v1 = masterBuild();
  const srv = serve(v1);
  const { config } = member(srv);
  await config.ensure(v1.manifest.version, MASTER);
  let count = 0;
  renameHook = (from) => {
    if (from.startsWith(`${join(own, "agent")}${sep}`) && ++count === 3) throw Object.assign(new Error("injected restore failure"), { code: "EIO" });
  };
  await rejectsConfig(config.restore(MASTER), /injected restore failure/);
  renameHook = null;
  assert.equal(config.state().version, null);

  srv.current = masterBuild({ rules: "master rules v2\n" });
  await config.apply(srv.current.manifest.version, MASTER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules v2\n");
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(read(join(own, "agent/models.json")), '{"providers":{"member":{}}}\n');
  assert.equal(JSON.parse(read(join(roots.agent, "settings.json"))).shellPath, "/member/bash");
  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
});

test("a crash in the middle of the first apply is put back after the restart, and the next apply backs up the original", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild();
  const srv = serve(build);
  crashAtSwap(3);
  await rejectsConfig(member(srv).config.ensure(build.manifest.version, MASTER), /injected crash/);
  dead = false;
  renameHook = null;
  assert.notDeepEqual(tree(), original, "the crash left a mixed tree");

  const { config } = member(srv);
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(read(join(own, "agent/models.json")), '{"providers":{"member":{}}}\n');
  assert.equal(JSON.parse(read(join(roots.agent, "settings.json"))).shellPath, "/member/bash");
  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
});

test("an ensure while a restore is pending is refused and changes nothing; after it, the server's apply applies as before", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild();
  const srv = serve(build);
  const { config, states } = member(srv);
  await config.ensure(build.manifest.version, MASTER);

  const leaving = (promise) =>
    assert.rejects(promise, (error) => {
      assert.equal(error.name, "HostOpError");
      assert.equal(error.status, 409);
      assert.equal(error.code, "cluster_config_failed");
      assert.equal(error.message, "This host is leaving the cluster");
      return true;
    });
  // The restore runs alongside, so the state is compared right around the call.
  const refusedUnchanged = async () => {
    const state = config.state();
    const reports = states.length;
    const refused = config.ensure(build.manifest.version, MASTER);
    assert.deepEqual(config.state(), state);
    assert.equal(states.length, reports);
    await leaving(refused);
  };
  // A later version's apply, held at its manifest, keeps the restore pending behind it.
  srv.current = masterBuild({ rules: "master rules v2\n" });
  const release = hold(srv);
  const applying = config.ensure(srv.current.manifest.version, MASTER);
  const restoring = config.restore(MASTER);
  await refusedUnchanged();
  release();
  srv.gate = null;
  await applying;
  await restoring;
  await sleep(20);
  assert.deepEqual(tree(), original);
  assert.deepEqual(config.state(), EMPTY);
  assert.ok(!states.some((state) => state.error === "This host is leaving the cluster"), "the refusal is never reported as the host's state");
  assert.equal(existsSync(own), false);

  srv.current = build;
  await config.apply(build.manifest.version, MASTER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n");
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
});

test("a linked directory above a mirrored entry refuses the restore before anything moves", async () => {
  const { config } = await firstApply();
  const outside = join(base, "outside-agents");
  renameSync(join(roots.home, ".agents"), outside);
  symlinkSync(outside, join(roots.home, ".agents"));
  const before = tree();
  await rejectsConfig(config.restore(MASTER), /real directory/);
  assert.ok(config.state().error.includes(join(roots.home, ".agents")));
  assert.deepEqual(tree(), before);
  assert.deepEqual(readdirSync(join(outside, "skills")), ["remote"]);
  assert.equal(read(join(own, "home/.agents/skills/home-skill/SKILL.md")), "home skill\n");
  assert.ok(existsSync(join(stateDir, "cluster-config", "state.json")));
});

test("a linked directory above a mirrored entry refuses the apply before anything moves", async () => {
  memberSetup();
  const outside = join(base, "outside-agents");
  put(outside, "skills/linked/SKILL.md", "linked\n");
  rmSync(join(roots.home, ".agents"), { recursive: true });
  symlinkSync(outside, join(roots.home, ".agents"));
  const before = tree();
  const build = masterBuild();
  const { config } = member(serve(build));
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /real directory/);
  assert.ok(config.state().error.includes(join(roots.home, ".agents")));
  assert.deepEqual(tree(), before);
  assert.deepEqual(readdirSync(join(outside, "skills")), ["linked"]);
  assert.equal(existsSync(own), false);
});

test("an entry on another filesystem than the state directory names both directories", async () => {
  memberSetup();
  const before = tree();
  const build = masterBuild();
  const { config } = member(serve(build));
  renameHook = (from) => {
    if (from === join(roots.home, ".agents/skills")) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  };
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /different filesystems; cluster configuration needs them on one filesystem/);
  renameHook = null;
  assert.ok(config.state().error.includes(`${join(roots.home, ".agents")} and ${join(own, "home", ".agents")}`));
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(own), false);
});

test("a manifest longer than 5 MiB is refused before anything is downloaded", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = serve({ manifest: { ...build.manifest, agentEnv: { BIG: "x".repeat(5_300_000) } }, content: build.content });
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /manifest is longer/);
  assert.deepEqual(srv.calls, [MANIFEST]);
  assert.deepEqual(tree(), before);
});

test("a start its server sent before the leave applies nothing once the restore came, until that server's next apply", async () => {
  memberSetup();
  const before = tree();
  const build = masterBuild();
  const srv = serve(build);
  const { config } = member(srv);
  // The leave of a member that never applied: nothing to put back, so it is over before the start gets here.
  await config.restore(MASTER);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /^This host has left the cluster$/);
  assert.deepEqual(srv.calls, [], "nothing was fetched");
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(own), false);
  assert.equal(existsSync(join(stateDir, "cluster-config")), false);

  await config.apply(build.manifest.version, MASTER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n");
  await config.ensure(build.manifest.version, MASTER);
});

const OTHER = "https://other.test";
/** Two masters with the same configuration, so only the server tells them apart. */
const twoServers = (build) => {
  const servers = { [MASTER]: serve(build, MASTER), [OTHER]: serve(build, OTHER) };
  return { servers, fetch: (url, path, signal) => servers[url].fetch(url, path, signal) };
};
const held = /^This host runs the cluster configuration of https:\/\/master\.test; it must leave that cluster first$/;
/** The servers among the two that `config` holds the configuration for. */
const holder = (config) => [MASTER, OTHER].filter((url) => config.holds(url));

test("a holder the daemon no longer links to (re-linked at a new address) gives way: the new address's restore puts the member's own back", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild();
  const { fetch } = twoServers(build);
  const linked = new Set([MASTER, OTHER]);
  const { config } = member({ fetch }, undefined, linked);
  await config.apply(build.manifest.version, MASTER);
  await config.restore(OTHER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n", "while the holder is linked, another address's leave keeps it");
  linked.delete(MASTER);
  assert.equal(config.holds(OTHER), true, "every address it links to may decide over a configuration whose holder it no longer links to");
  await config.restore(OTHER);
  assert.deepEqual(tree(), original);
  assert.deepEqual(holder(config), []);
});

test("a holder the daemon no longer links to gives way: the new address's apply takes the host over without a download", async () => {
  memberSetup();
  const build = masterBuild();
  const { servers, fetch } = twoServers(build);
  const linked = new Set([MASTER, OTHER]);
  const { config, states } = member({ fetch }, undefined, linked);
  await config.apply(build.manifest.version, MASTER);
  await rejectsConfig(config.ensure(build.manifest.version, OTHER), held);
  linked.delete(MASTER);
  const reports = states.length;
  await config.ensure(build.manifest.version, OTHER);
  assert.equal(JSON.parse(read(join(own, "server.json"))), OTHER);
  linked.add(MASTER);
  assert.deepEqual(holder(config), [OTHER], "recorded: the old address no longer holds it, linked again or not");
  assert.ok(states.length > reports, "the change of holder is reported");
  assert.deepEqual(servers[OTHER].calls, [], "the version it holds needs no download");
  await rejectsConfig(config.apply(build.manifest.version, MASTER), /^This host runs the cluster configuration of https:\/\/other\.test; it must leave that cluster first$/);
  await config.restore(OTHER);
  assert.deepEqual(holder(config), []);
});

test("one cluster per host: another server's apply and starts are refused until the holding server's restore, after a restart too", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild();
  const { servers, fetch } = twoServers(build);
  const first = member({ fetch });
  await first.config.apply(build.manifest.version, MASTER);
  await checked(first.config);
  assert.deepEqual(holder(first.config), [MASTER]);
  assert.equal(JSON.parse(read(join(own, "server.json"))), MASTER, "the backup names the server it was taken for");
  const state = first.config.state();
  await rejectsConfig(first.config.apply(build.manifest.version, OTHER), held);
  await rejectsConfig(first.config.ensure(build.manifest.version, OTHER), held);
  assert.deepEqual(servers[OTHER].calls, []);
  assert.deepEqual(first.config.state(), state, "a refusal is not this host's state");
  // The other server's leave: not its configuration to put back.
  await first.config.restore(OTHER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n");
  assert.deepEqual(holder(first.config), [MASTER]);
  await first.config.stop();

  const { config } = member({ fetch });
  assert.deepEqual(holder(config), [MASTER], "after a restart too");
  await rejectsConfig(config.apply(build.manifest.version, OTHER), held);
  await config.restore(MASTER);
  assert.deepEqual(tree(), original);
  assert.deepEqual(holder(config), []);
  assert.equal(existsSync(join(own, "server.json")), false);
  await config.apply(build.manifest.version, OTHER);
  assert.deepEqual(holder(config), [OTHER]);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n");
  assert.deepEqual(servers[OTHER].calls.slice(0, 1), [MANIFEST]);
  await config.restore(OTHER);
  assert.deepEqual(tree(), original);
});

test("two servers' first applies at once: the first in the queue takes the host, the other is refused without a request or a report", async () => {
  memberSetup();
  const build = masterBuild();
  const { servers, fetch } = twoServers(build);
  const { config, states } = member({ fetch });
  const [first, second] = await Promise.allSettled([config.apply(build.manifest.version, MASTER), config.apply(build.manifest.version, OTHER)]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.match(second.reason.message, held);
  assert.deepEqual(servers[OTHER].calls, []);
  assert.ok(states.every((reported) => reported.error === null));
  assert.deepEqual(holder(config), [MASTER]);
});

/** A master that never finishes a request: the manifest's headers (or, with `body`, every file's body) wait until the request is aborted. */
function stalled({ body = false, build } = {}) {
  const srv = { calls: [] };
  const hang = (signal) => new ReadableStream({ start: (controller) => signal.addEventListener("abort", () => controller.error(signal.reason), { once: true }) });
  srv.fetch = (serverUrl, path, signal) => {
    srv.calls.push(path);
    if (body && path === MANIFEST) return Promise.resolve(Response.json(build.manifest));
    if (body) return Promise.resolve(new Response(hang(signal)));
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  return srv;
}

test("a master that stops answering fails the apply within the request time limit, headers or body, and changes nothing", async (t) => {
  memberSetup();
  const before = tree();
  const saved = clusterConfigTimings.fetchMs;
  clusterConfigTimings.fetchMs = 100;
  t.after(() => {
    clusterConfigTimings.fetchMs = saved;
  });
  const build = masterBuild();
  for (const [srv, what] of [[stalled(), "the manifest"], [stalled({ body: true, build }), build.manifest.files[0].path]]) {
    const { config } = member(srv);
    const started = Date.now();
    await rejectsConfig(config.ensure(build.manifest.version, MASTER), new RegExp(`^the master did not send ${what.replaceAll(".", "\\.")} within 0\\.1 s$`));
    assert.ok(Date.now() - started < 3000, "failed at the time limit");
    assert.equal(config.state().files, "failed");
    assert.deepEqual(tree(), before);
    assert.equal(existsSync(own), false);
  }
});

test("stop aborts a stalled request to the master at once instead of waiting for its time limit", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = stalled({ body: true, build });
  const { config } = member(srv);
  const applying = config.ensure(build.manifest.version, MASTER);
  for (let i = 0; i < 200 && srv.calls.length < 2; i++) await sleep(5);
  assert.equal(srv.calls.length, 2, "the first file's body is stalled");
  const started = Date.now();
  await config.stop();
  assert.ok(Date.now() - started < 3000, "the stop did not wait for the 30 s limit");
  await rejectsConfig(applying, /^the host daemon is stopping$/);
  assert.equal(existsSync(own), false);
});

test("another server's restore answers at once, and the holder's starts are not refused", async () => {
  memberSetup();
  const build = masterBuild();
  const { fetch } = twoServers(build);
  const { config } = member({ fetch });
  await config.ensure(build.manifest.version, MASTER);
  await config.restore(OTHER);
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n");
  assert.deepEqual(holder(config), [MASTER]);
  await config.stop();
});
