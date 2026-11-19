import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";

const dir = mkdtempSync(join(tmpdir(), "omp-hub-v7-"));
process.env.PI_CODING_AGENT_DIR = dir;
// The master's configuration version, set per test: the real one reads the agent and home directories.
const VERSION = "a".repeat(64);
let master = async () => VERSION;
const realConfig = await import("./cluster-config-server.ts");
mock.module("./cluster-config-server.ts", () => ({ ...realConfig, clusterConfigVersion: () => master() }));
const { ClusterConfigError } = await import("./cluster-config.ts");
const hub = await import("./hub.ts");
const { RpcProcess } = await import("../pi/rpc-process.ts");
const { rotateLocalHostToken } = await import("./registry.ts");
const { savePools } = await import("./pools.ts");
const { HostOpError, LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
const { AgentSessionWrapper, getRpcSession, startRpcSession, subscribeRunningSessions } = await import("../rpc-manager.ts");
const { LinkDriver, linkHost, ompChild, until } = await import("./link-driver.test-helper.mjs");
const { closeNotificationStore } = await import("../notification-store.ts");
const { closeOutboxStore } = await import("../message-outbox.ts");

test.after(() => {
  hub.flushLinkSamples();
  closeNotificationStore();
  closeOutboxStore();
  rmSync(dir, { recursive: true, force: true });
});

let serial = 0;
const sessionId = () => `11111111-2222-4333-8444-${String(++serial).padStart(12, "0")}`;
const launch = (id) => ({ cwd: "/w", recordedCwd: "/w", sessionFile: `/sessions/${id}.jsonl` });
const ev = (event) => JSON.stringify(event);
const snapshot = (text = "before") => ev({ type: "message_update", messageId: "m", message: { role: "assistant", content: [{ type: "text", text }] } });
const result = (ch, extras = {}) => ({ ch, joined: true, pending: [], streaming: null, cwd: "/w", fellBack: false, ...extras });

async function sharedLink(t, id, { listed = false, pending = [], streaming = null, state = {}, fail = null, leaseBusy = false } = {}) {
  let ch = `shared-${id}`;
  let alive = true;
  let coldStarts = 0;
  const link = await linkHost(`Shared ${id}`, {
    hello: { v: LINK_PROTOCOL_VERSION, link: { id: "l1", notifier: true } },
    channels: listed ? [{ ch, sessionId: id, cwd: "/w", pending }] : [],
  });
  const messages = [];
  const opens = [];
  const closes = [];
  const leases = [];
  const child = ompChild(link, id, { state, fail });
  const serving = link.serve({
    async open(args) {
      opens.push(args);
      if (args.expectedChannel && (args.expectedChannel !== ch || !alive)) {
        throw new HostOpError(404, "session_not_running", "The advertised channel exited");
      }
      if (!alive) { alive = true; coldStarts++; }
      return result(ch, { pending, streaming: typeof streaming === "function" ? streaming(opens.length) : streaming });
    },
    close({ ch }) { closes.push(ch); return {}; },
    editLease({ on }) {
      leases.push(on);
      if (on && leaseBusy) throw new HostOpError(409, "session_busy", "Another web app is editing this session's history; retry once it finishes");
      return {};
    },
    sessionFileExists() { return true; },
    invalidateSessionLists() { return null; },
    listSessions() { return [{ id, cwd: "/w", path: launch(id).sessionFile, created: "c", modified: "m", messageCount: 1, firstMessage: "hi" }]; },
  }, async (message) => {
    messages.push(message);
    if (message.type === "kill") { alive = false; await link.post({ type: "exit", ch, code: 0, signal: null }); }
    else await child(message);
  });
  t.after(async () => {
    await getRpcSession(id)?.destroyAndWait();
    hub.closeHostLink(link.id);
    await serving;
  });
  return { link, get ch() { return ch; }, get coldStarts() { return coldStarts; }, messages, opens, closes, leases,
    async exit() { alive = false; await link.post({ type: "exit", ch, code: 0, signal: null }); } };
}

test("shell exclusion is forwarded on every bash command, including after reload", async (t) => {
  const id = sessionId();
  const { link, messages } = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(link.id));
  const command = { type: "bash", command: "printf secret", excludeFromContext: true };
  await session.send(command);
  await session.send({ type: "reload" });
  await session.send(command);
  const executions = messages.filter((m) => m.type === "stdin").map((m) => JSON.parse(m.line)).filter((m) => m.type === "bash");
  assert.equal(executions.length, 2);
  assert.ok(executions.every((m) => m.excludeFromContext === true));
});

// A promise continuation is too late: the following stdout is applied in the same WebSocket frame.
test("v7 open installs the returned channel and snapshot before same-frame live output", async (t) => {
  const id = sessionId();
  const link = await linkHost("Atomic open", { hello: { v: LINK_PROTOCOL_VERSION, link: { id: "l1", notifier: true } } });
  t.after(() => hub.closeHostLink(link.id));
  const opening = hub.getHost(link.id).spawnRpc(launch(id), id);
  const req = await link.next();
  assert.equal(req.op, "open");
  assert.deepEqual(req.args, { sessionId: id, launch: launch(id) });
  const dialog = JSON.stringify({ type: "ui_request", id: 5, method: "askDialog", args: [[]] });
  await link.post(
    { type: "channels_changed", channels: [{ ch: "canonical", sessionId: id, cwd: "/w", pending: [] }] },
    { type: "res", id: req.id, ok: true, result: result("canonical", { pending: [dialog], streaming: snapshot() }) },
    { type: "stdout", ch: "canonical", line: JSON.stringify({ type: "notice", message: "later" }) },
  );
  const spawned = await opening;
  const frames = [];
  const proc = new RpcProcess({ cwd: "/w", transport: spawned.transport, adopted: true, onFrame: frame => frames.push(frame) });
  assert.equal(spawned.transport.hostOwnedLifecycle, true);
  assert.equal(spawned.transport.id, "canonical");
  proc.replay([...spawned.pending, spawned.streaming]);
  proc.release();
  assert.deepEqual(frames, [{ type: "ui_request", id: 5, method: "askDialog", args: [[]] }, JSON.parse(snapshot()), { type: "notice", message: "later" }]);
  spawned.transport.setInterest(true);
  spawned.transport.setPreparing(true);
  spawned.transport.setPreparing(false);
  const registration = spawned.transport.setHostTools([{ name: "open_url", description: "Open", parameters: { type: "object", properties: {} } }], [{ scheme: "browser", writable: false }]);
  await registration;
  await assert.rejects(spawned.transport.setHostTools([{ name: "broken", parameters: [] }], [{ scheme: "browser", writable: false }]), error => error.status === 400);
  spawned.transport.close();
  const sent = [];
  for (;;) {
    const message = await link.next();
    sent.push(message);
    if (message.type === "req" && message.op === "close") break;
  }
  assert.deepEqual(sent.filter(m => m.type === "interest").map(({ on, preparing }) => ({ on, preparing })), [
    { on: true, preparing: false }, { on: true, preparing: true }, { on: true, preparing: false },
  ]);
  assert.deepEqual(sent.find(m => m.type === "host_tools").schemes, [{ scheme: "browser", writable: false }]);
  assert.equal(sent.some(m => m.type === "kill"), false);
});

async function linkedHost(t, label) {
  const link = await linkHost(label, { hello: { v: LINK_PROTOCOL_VERSION, link: { id: "l1", notifier: true } } });
  t.after(() => hub.closeHostLink(link.id));
  return link;
}

async function openedLaunch(link, options, host = hub.getHost(link.id)) {
  const id = sessionId();
  const opening = host.spawnRpc(launch(id), id, options);
  const req = await link.next();
  assert.equal(req.op, "open");
  await link.post({ type: "res", id: req.id, ok: true, result: result(options?.expectedChannel ?? "c1") });
  await opening;
  return req.args.launch;
}

async function assertNothingSent(link) {
  hub.closeHostLink(link.id);
  for (let message = await link.next(); message; message = await link.next()) assert.notEqual(message.type, "req");
}

// The first pool is the cluster.
const poolsFile = join(dir, "tau", "pools.json");
const hostsFile = join(dir, "tau", "hosts.json");
function seedCluster(t, ...hostIds) {
  savePools([{
    id: "cluster", label: "Cluster", enabled: true, projects: [],
    members: hostIds.map((hostId) => ({ hostId, projectsRoot: "/srv/p", provisioned: true, draining: false })),
  }]);
  t.after(() => rmSync(poolsFile, { force: true }));
}

test("this machine as a cluster member gets no configuration version", async (t) => {
  const link = new LinkDriver("local", rotateLocalHostToken());
  await link.dial({ hello: { v: LINK_PROTOCOL_VERSION, link: { id: "l1", notifier: true } } });
  t.after(() => hub.closeHostLink("local"));
  seedCluster(t, "local");
  assert.equal("configVersion" in await openedLaunch(link), false);
});

test("a pure join for a member reads neither the registry nor the pools, is not refused and gets no version", async (t) => {
  const link = await linkedHost(t, "Member join");
  seedCluster(t, link.id);
  const [hosts, pools] = [readFileSync(hostsFile), readFileSync(poolsFile)];
  const host = hub.getHost(link.id); // looked up while hosts.json is still readable
  t.after(() => { writeFileSync(hostsFile, hosts); writeFileSync(poolsFile, pools); });
  writeFileSync(hostsFile, "not json");
  writeFileSync(poolsFile, "not json");
  assert.equal("configVersion" in await openedLaunch(link, { expectedChannel: "c1" }, host), false);
});

test("an unreadable pools.json refuses a start with 503 and sends nothing", async (t) => {
  const link = await linkedHost(t, "Pools gone");
  const host = hub.getHost(link.id);
  t.after(() => rmSync(poolsFile, { force: true }));
  writeFileSync(poolsFile, "not json");
  const id = sessionId();
  await assert.rejects(host.spawnRpc(launch(id), id), (error) => error.status === 503 && error.code === "pool_storage_unavailable");
  await assertNothingSent(link);
});

// A member runs on the master's configuration, so a start carries its version (spec K3, K4).
const configState = (fields = {}) => ({ version: null, files: "none", error: null, missingCommands: [], ...fields });
const configRow = (link) => hub.listHosts().find((row) => row.id === link.id).clusterConfig;

test("a cluster member gets the master's configuration version on the open launch; a host outside the cluster does not", async (t) => {
  const member = await linkedHost(t, "Config member");
  const outside = await linkedHost(t, "Config outside");
  seedCluster(t, member.id);
  const launched = await openedLaunch(member);
  assert.equal(launched.configVersion, VERSION);
  assert.equal("configVersion" in await openedLaunch(outside), false);
});

test("an invalid master configuration refuses a member's start with 409 cluster_config_invalid and sends nothing", async (t) => {
  const link = await linkedHost(t, "Config invalid");
  seedCluster(t, link.id);
  master = async () => { throw new ClusterConfigError("invalid_settings", "settings.json is not a valid JSON object"); };
  t.after(() => { master = async () => VERSION; });
  const id = sessionId();
  await assert.rejects(hub.getHost(link.id).spawnRpc(launch(id), id),
    (error) => error.status === 409 && error.code === "cluster_config_invalid" && error.message === "settings.json is not a valid JSON object");
  await assertNothingSent(link);
});

test("a pure join on a member is neither refused nor given a version", async (t) => {
  const link = await linkedHost(t, "Config join");
  seedCluster(t, link.id);
  master = async () => { throw new ClusterConfigError("unreadable", "skills cannot be read (EACCES)"); };
  t.after(() => { master = async () => VERSION; });
  assert.equal("configVersion" in await openedLaunch(link, { expectedChannel: "c1" }), false);
});

test("a master configuration the members cannot get is in the hosts snapshot, its code and message only, until it works again", async (t) => {
  const failure = new ClusterConfigError("file_too_large", "skills/big.md is 6000000 bytes, over the 5242880 byte limit");
  master = async () => { throw failure; };
  t.after(() => { master = async () => VERSION; });
  let changes = 0;
  t.after(hub.onHostsChange(() => changes++));
  await assert.rejects(hub.masterConfigVersion(), failure);
  assert.deepEqual(hub.hostsSnapshot().masterConfigError, { code: "file_too_large", message: failure.message });
  await until(() => changes === 1);
  await assert.rejects(hub.masterConfigVersion(), failure);
  assert.equal(changes, 1, "the same failure again changes nothing");

  master = async () => { throw new TypeError("secret: value from settings.json"); };
  await assert.rejects(hub.masterConfigVersion(), TypeError);
  assert.deepEqual(hub.hostsSnapshot().masterConfigError, { code: "unknown", message: "TypeError" }, "anything else by its name only");

  master = async () => VERSION;
  assert.equal(await hub.masterConfigVersion(), VERSION);
  assert.equal("masterConfigError" in hub.hostsSnapshot(), false);
});

test("a member that leaves while its start waits for the master's version starts without one", async (t) => {
  const link = await linkedHost(t, "Config leaving start");
  seedCluster(t, link.id);
  const called = Promise.withResolvers(), gate = Promise.withResolvers();
  master = () => { called.resolve(); return gate.promise; };
  t.after(() => { master = async () => VERSION; });
  const id = sessionId();
  const opening = hub.getHost(link.id).spawnRpc(launch(id), id);
  await called.promise;
  seedCluster(t);
  gate.resolve(VERSION);
  const req = await link.next();
  assert.deepEqual(req.args.launch, launch(id), "neither a version nor the member's credentials");
  await link.post({ type: "res", id: req.id, ok: true, result: result("c1") });
  await opening;
});

test("a config_state report updates the host row and whether it is current", async (t) => {
  const link = await linkedHost(t, "Config reporting");
  await hub.masterConfigVersion();
  let changes = 0;
  t.after(hub.onHostsChange(() => { changes++; }));
  assert.equal(configRow(link), undefined);
  const behind = configState({ version: "b".repeat(64), files: "current" });
  await link.post({ type: "config_state", state: behind, owned: true });
  assert.deepEqual(configRow(link), { ...behind, owned: true, current: false });
  assert.equal(changes, 1);
  await link.post({ type: "config_state", state: { ...behind, version: VERSION }, owned: true });
  assert.equal(configRow(link).current, true);
  assert.equal(changes, 2);
  await link.post({ type: "config_state", state: { ...behind, version: VERSION }, owned: true });
  assert.equal(changes, 2, "an unchanged report notifies nobody");
  await link.post({ type: "config_state", state: { ...behind, version: VERSION }, owned: false });
  assert.deepEqual([configRow(link).owned, configRow(link).current], [false, false], "the same version held for another server is not this cluster's");
  assert.equal(changes, 3);
});

test("the sync applies to every online member that is not current, restores a linked non-member holding this server's configuration, and piles nothing on", async (t) => {
  const links = {};
  for (const name of ["behind", "failed", "foreign", "silent", "current", "holding", "outside"]) {
    links[name] = await linkedHost(t, `Config sync ${name}`);
  }
  seedCluster(t, "local", ...["behind", "failed", "foreign", "silent", "current"].map((name) => links[name].id));
  const report = (name, fields, owned) => links[name].post({ type: "config_state", state: configState(fields), owned });
  const done = { files: "current" };
  await report("behind", { version: "b".repeat(64), ...done }, true);
  await report("failed", { version: VERSION, files: "failed", error: "the master answered 500 for the manifest" }, true);
  await report("foreign", { version: VERSION, ...done }, false);
  await report("current", { version: VERSION, ...done }, true);
  await report("holding", { version: "c".repeat(64), ...done }, true);
  await report("outside", { version: "c".repeat(64), ...done }, false);
  await hub.syncClusterConfig();
  await hub.syncClusterConfig(); // the ops of the first are unanswered: nothing more
  const apply = ["clusterConfig", { action: "apply", version: VERSION }];
  for (const name of ["failed", "foreign", "silent"]) assert.deepEqual(await links[name].next().then((req) => [req.op, req.args]), apply, name);
  const req = await links.behind.next();
  assert.deepEqual([req.op, req.args], apply);
  await links.behind.post({ type: "res", id: req.id, ok: true, result: { state: configState({ version: VERSION, files: "current" }), owned: true } });
  const restore = await links.holding.next();
  assert.deepEqual([restore.op, restore.args], ["clusterConfig", { action: "restore" }]);
  for (const link of Object.values(links)) await assertNothingSent(link);
});

test("an apply's answer never takes back a newer report: the MCP command check finishing is reported ahead of the answer", async (t) => {
  const link = await linkedHost(t, "Config stale answer");
  seedCluster(t, link.id);
  await hub.masterConfigVersion();
  const applying = hub.clusterConfigOp(link.id, { action: "apply", version: VERSION });
  const req = await link.next();
  // The daemon reports each change at once; its answer, computed before the check ended, is sequenced behind.
  await link.post({ type: "config_state", state: configState({ version: VERSION, files: "current", missingCommands: ["uvx"] }), owned: true });
  await link.post({ type: "res", id: req.id, ok: true, result: { state: configState({ version: VERSION, files: "current" }), owned: true } });
  assert.deepEqual((await applying).state.missingCommands, [], "the caller still gets the answer");
  assert.deepEqual(configRow(link).missingCommands, ["uvx"]);
  assert.equal(hub.isHostConfigCurrent(link.id), true);
});

test("a linked non-member without omp still gets its restore; a member without omp gets no apply", async (t) => {
  const noOmp = (label) => linkHost(label, { hello: { v: LINK_PROTOCOL_VERSION, piVersion: null, link: { id: "l1", notifier: true } } });
  const left = await noOmp("Config left without omp");
  const member = await noOmp("Config member without omp");
  t.after(() => [left, member].forEach((link) => hub.closeHostLink(link.id)));
  seedCluster(t, member.id);
  await left.post({ type: "config_state", state: configState({ version: "c".repeat(64), files: "current" }), owned: true });
  await member.post({ type: "config_state", state: configState(), owned: false });
  await hub.syncClusterConfig();
  const restore = await left.next();
  assert.deepEqual([restore.op, restore.args], ["clusterConfig", { action: "restore" }]);
  for (const link of [left, member]) await assertNothingSent(link);
});

test("a linked non-member that has not reported since its link came up gets one restore, and none once its answer says it holds nothing", async (t) => {
  const link = await linkedHost(t, "Config unreported");
  seedCluster(t, "local");
  // Its link-up config_state never arrived (dropped on a full send buffer).
  await hub.syncClusterConfig();
  await hub.syncClusterConfig(); // the first one's restore is unanswered: nothing more
  const req = await link.next();
  assert.deepEqual([req.op, req.args], ["clusterConfig", { action: "restore" }]);
  await link.post({ type: "res", id: req.id, ok: true, result: { state: configState(), owned: false } });
  await until(() => configRow(link) !== undefined, "the answer is kept like a report");
  await hub.syncClusterConfig();
  await assertNothingSent(link);
});

test("a relinked non-member can settle its restore from the answer when its new report is missing", async (t) => {
  const link = await linkedHost(t, "Config relink unreported");
  seedCluster(t, "local");
  await link.post({ type: "config_state", state: configState(), owned: true });
  assert.equal(configRow(link).owned, true);
  link.drop();
  await link.dial();
  // The previous link reported; this link's report was lost before its restore answered.
  await hub.syncClusterConfig();
  const req = await link.next();
  assert.deepEqual([req.op, req.args], ["clusterConfig", { action: "restore" }]);
  await link.answer(req, { state: configState(), owned: false });
  await until(() => configRow(link)?.owned === false, "the new link's restore answer settles ownership");
  await hub.syncClusterConfig();
  await assertNothingSent(link);
});

test("this machine's own daemon link never gets a restore, whether or not it is a member", async (t) => {
  const link = new LinkDriver("local", rotateLocalHostToken());
  await link.dial({ hello: { v: LINK_PROTOCOL_VERSION, link: { id: "l1", notifier: true } } });
  t.after(() => hub.closeHostLink("local"));
  seedCluster(t);
  await hub.syncClusterConfig(); // unreported
  await link.post({ type: "config_state", state: configState({ version: "c".repeat(64), files: "current" }), owned: true });
  await hub.syncClusterConfig();
  await assertNothingSent(link);
});

test("the sync starts with one round at once", async (t) => {
  const link = await linkedHost(t, "Config at start");
  seedCluster(t, link.id);
  t.after(() => {
    clearInterval(globalThis.__ompHostHub.configSync);
    globalThis.__ompHostHub.configSync = undefined;
  });
  hub.startClusterConfigSync();
  const req = await link.next();
  assert.deepEqual([req.op, req.args], ["clusterConfig", { action: "apply", version: VERSION }]);
});

test("a member that leaves while the sync reads the master's version gets no apply", async (t) => {
  const leaving = await linkedHost(t, "Config leaving sync");
  seedCluster(t, leaving.id);
  const called = Promise.withResolvers(), gate = Promise.withResolvers();
  master = () => { called.resolve(); return gate.promise; };
  t.after(() => { master = async () => VERSION; });
  const sync = hub.syncClusterConfig();
  await called.promise;
  seedCluster(t);
  gate.resolve(VERSION);
  await sync;
  await assertNothingSent(leaving);
});

test("a new master version goes to the members at once, not at the next 30 s round", async (t) => {
  const link = await linkedHost(t, "Config master change");
  seedCluster(t, link.id);
  await link.post({ type: "config_state", state: configState({ version: VERSION, files: "current" }), owned: true });
  assert.equal(await hub.masterConfigVersion(), VERSION);
  const changed = "d".repeat(64);
  master = async () => changed;
  t.after(() => {
    master = async () => VERSION;
    globalThis.__ompHostHub.masterConfig.version = VERSION;
  });
  assert.equal(await hub.masterConfigVersion(), changed);
  const req = await link.next();
  assert.deepEqual([req.op, req.args], ["clusterConfig", { action: "apply", version: changed }]);
});

test("v7 joined wrappers skip child-global startup, report interest and preserve concurrent preparation", async (t) => {
  const id = sessionId();
  const { link, messages } = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(link.id));
  const detach = session.onEvent(() => {});
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const first = session.withPendingCommand(() => gates[0].promise);
  const second = session.withPendingCommand(() => gates[1].promise);
  gates[0].resolve();
  await first;
  await until(() => messages.filter(m => m.type === "interest").at(-1)?.preparing === true, "preparation interest");
  assert.equal(messages.filter(m => m.type === "interest").at(-1).preparing, true);
  gates[1].resolve();
  await second;
  detach();
  await until(() => messages.filter(m => m.type === "interest").at(-1)?.on === false, "interest released");
  const startup = new Set(["set_host_tools", "set_host_uri_schemes"]);
  assert.deepEqual(messages.filter(m => m.type === "stdin" && startup.has(JSON.parse(m.line).type)), []);
  await session.destroyAndWait();
  assert.equal(messages.some(m => m.type === "kill"), false);
});

test("v7 hello eagerly joins background runs and resync restores the daemon snapshot without changing filters", async (t) => {
  const id = sessionId();
  const dialog = JSON.stringify({ type: "ui_request", id: 9, method: "askDialog", args: [[]] });
  const { link, ch, messages, opens } = await sharedLink(t, id, { listed: true, pending: [dialog], streaming: snapshot("whole"), state: { isStreaming: true } });
  await until(() => getRpcSession(id)?.isAlive(), "background adoption");
  const wrapper = getRpcSession(id);
  assert.equal(wrapper.hasSubscribers(), false);
  assert.equal(wrapper.isRunning(), true);
  assert.equal(wrapper.getStreamSnapshot().streamingMessage.content[0].text, "whole");
  assert.equal(opens.length, 1);
  await link.post({ type: "resync", ch });
  await until(() => opens.length === 2, "snapshot reopen");
  await until(() => messages.filter(m => m.type === "stdin" && JSON.parse(m.line).type === "get_state").length >= 2, "resync state");
  assert.equal(wrapper.getStreamSnapshot().streamingMessage.content[0].text, "whole");
  await link.post({ type: "stdout", ch, line: ev({ type: "message_update", messageId: "m", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " plus" } }) });
  assert.equal(wrapper.getStreamSnapshot().streamingMessage.content[0].text, "whole plus");
  assert.equal(opens.length, 2, "a daemon snapshot is a valid delta base");
  const events = [];
  const detach = wrapper.onEvent(event => events.push(event));
  assert.ok(events.some(event => event.type === "ui_request" && event.id === 9));
  detach();
});

test("v7 failed adoption and unidentifiable hello children close only membership", async (t) => {
  const id = sessionId();
  const { messages, closes, ch } = await sharedLink(t, id, { listed: true, fail: "get_state" });
  await until(() => closes.includes(ch), "failed adoption closes membership");
  await until(() => !getRpcSession(id), "failed wrapper removed");
  assert.equal(messages.some(m => m.type === "kill"), false);
  const link = await linkHost("Unknown shared child", { hello: { v: LINK_PROTOCOL_VERSION, link: { id: "l1", notifier: true } }, channels: [{ ch: "unknown", sessionId: null, cwd: "/w", pending: null }] });
  t.after(() => hub.closeHostLink(link.id));
  const close = await link.next();
  assert.equal(close.op, "close");
  assert.deepEqual(close.args, { ch: "unknown" });
});

test("v7 notifier handoff gates automatic publication only", async (t) => {
  const id = sessionId();
  const { link } = await sharedLink(t, id);
  assert.equal(hub.isNotifier(link.id), true);
  await link.post({ type: "notifier", on: false });
  assert.equal(hub.isNotifier(link.id), false);
  const { publishNotification, attachNotificationClient, reportPresence } = await import("../notification-hub.ts");
  const { saveDevice } = await import("../notification-store.ts");
  const delivered = [];
  saveDevice("v7-device", { enabled: true, types: { completed: true, input: true, error: true, modelSwitch: true }, whenActive: "toast", locale: "en" });
  reportPresence({ clientId: "v7-tab", deviceId: "v7-device", visible: false, sessionId: null, seq: 1 });
  t.after(attachNotificationClient("v7-tab", event => delivered.push(event)));
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(link.id));
  await link.post({ type: "stdout", ch: session.proc.transport.id, line: ev({ type: "agent_start" }) });
  await link.post({ type: "stdout", ch: session.proc.transport.id, line: ev({ type: "session_settled" }) });
  assert.equal(delivered.length, 0, "non-notifier cannot publish an automatic completion");
  // Explicit test notifications have no host identity and must not be globally suppressed.
  publishNotification({ type: "completed", sessionId: id, sessionName: "Test" });
  assert.ok(delivered.length > 0);
  delivered.length = 0;
  await link.post({ type: "notifier", on: true });
  await link.post({ type: "stdout", ch: session.proc.transport.id, line: ev({ type: "agent_start" }) });
  await link.post({ type: "stdout", ch: session.proc.transport.id, line: ev({ type: "session_settled" }) });
  assert.deepEqual(delivered.map(message => message.event.type), ["completed"]);
});

test("v7 sessions_changed invalidates host list cache and broadcasts refresh", async (t) => {
  const link = await linkHost("Changed lists", { hello: { v: LINK_PROTOCOL_VERSION, link: { id: "l1", notifier: true } } });
  t.after(() => hub.closeHostLink(link.id));
  let lists = 0;
  const serving = link.serve({ listSessions: () => { lists++; return []; } });
  const { hostSessions } = await import("./session-index.ts");
  await hostSessions(link.id);
  const updates = [];
  t.after(subscribeRunningSessions(update => updates.push(update)));
  await link.post({ type: "sessions_changed" });
  await until(() => updates.some(update => update.refreshSessionList), "list refresh broadcast");
  await hostSessions(link.id);
  assert.equal(lists, 2);
  hub.closeHostLink(link.id);
  await serving;
});

test("shared RpcProcess disposal closes membership; explicit disposal still kills", async () => {
  for (const explicit of [false, true]) {
    let exited;
    const calls = [];
    const transport = {
      hostOwnedLifecycle: true,
      onLine() {}, onStderr() {}, onExit(listener) { exited = listener; },
      write(_line, done) { done(); },
      close() { calls.push("close"); exited(null, null); },
      endInput() { calls.push("end"); exited(0, null); },
      killTree() { calls.push("kill"); exited(0, null); },
    };
    const proc = new RpcProcess({ cwd: "/w", transport });
    await proc.dispose(5, explicit);
    assert.deepEqual(calls, explicit ? ["kill"] : ["close"]);
  }
});

test("v7 wrappers leave both stop timers to the daemon and keep ordinary tool results", async (t) => {
  const events = [];
  const interest = [];
  let feed;
  let closes = 0;
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    transport: { hostOwnedLifecycle: true, setInterest(on) { interest.push(on); } },
    onFrame(listener) { feed = listener; return () => {}; },
    dispose: async () => { closes++; },
  }, "/w", null, sessionId(), 1, { id: "fake", status: () => "online", onStatus: () => () => {} });
  wrapper.start();
  const detach = wrapper.onEvent(event => events.push(event));
  feed({ type: "tool_execution_end", toolCallId: "native-once", result: { content: [{ type: "text", text: "shared result" }] } });
  detach();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal(wrapper.isAlive(), true);
  assert.equal(closes, 0);
  assert.deepEqual(interest, [false, true, false]);
  assert.ok(events.some(event => event.type === "tool_execution_end" && event.toolCallId === "native-once"));
  await wrapper.destroyAndWait();
});

test("resume manifests retain legacy hosts but exclude v7 hosts", async (t) => {
  const id = sessionId();
  const { link } = await sharedLink(t, id);
  const { saveWebServerSettings } = await import("../web-settings.ts");
  const { recordRunningSessions, resumeOnHostLink } = await import("../session-resume.ts");
  const tracker = globalThis.__ompResumeTracker;
  globalThis.__ompResumeTracker = undefined;
  t.after(() => { globalThis.__ompResumeTracker = tracker; });
  saveWebServerSettings({ autoResumeSessions: true });
  const legacy = { id: sessionId(), hostId: "legacy-offline" };
  const shared = { id, hostId: link.id };
  recordRunningSessions([shared, legacy], () => true);
  const manifest = join(dir, `tau-interrupted-sessions-${process.pid}.json`);
  assert.equal(existsSync(manifest), true);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")).sessions, [legacy]);
  const resumed = [];
  resumeOnHostLink([shared], async entry => resumed.push(entry));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(resumed, []);
});

test("shared callback snapshots cannot execute a browser action twice", async (t) => {
  const id = sessionId();
  const pending = [];
  const { link, ch, opens } = await sharedLink(t, id, { pending });
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(link.id));
  await session.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  const events = [];
  const detach = session.onEvent(event => events.push(event));
  t.after(detach);
  const call = { type: "host_tool_call", id: "one-action", toolName: "open_url", arguments: { url: "https://example.test" } };
  await link.post({ type: "stdout", ch, line: JSON.stringify(call) });
  pending.push(JSON.stringify(call));
  await link.post({ type: "resync", ch });
  await until(() => opens.length === 2, "callback resync");
  assert.equal(events.filter(event => event.type === "host_tool_call").length, 1);
});

test("adopted shared web callbacks report unknown outcome instead of blindly repeating an action", async (t) => {
  const id = sessionId();
  const call = JSON.stringify({ type: "host_tool_call", id: "before-restart", toolName: "open_url", arguments: { url: "https://example.test" } });
  const { messages } = await sharedLink(t, id, { listed: true, pending: [call] });
  await until(() => getRpcSession(id)?.isAlive(), "adopted callback owner");
  await until(() => messages.some(message => message.type === "stdin" && JSON.parse(message.line).type === "host_tool_result"), "ambiguous callback result");
  const reply = messages.filter(message => message.type === "stdin").map(message => JSON.parse(message.line)).find(frame => frame.type === "host_tool_result");
  assert.equal(reply.id, "before-restart");
  assert.equal(reply.isError, true);
  assert.match(reply.result.content[0].text, /outcome is unknown/);
  const events = [];
  const detach = getRpcSession(id).onEvent(event => events.push(event));
  detach();
  assert.equal(events.some(event => event.type === "host_tool_call"), false);
});

test("v7 channels_changed observes a newly created run without any tab", async (t) => {
  const id = sessionId();
  const { link, ch, opens } = await sharedLink(t, id, { state: { isStreaming: true } });
  assert.equal(getRpcSession(id), undefined);
  await link.post({ type: "channels_changed", channels: [{ ch, sessionId: id, cwd: "/w", pending: [] }] });
  await until(() => getRpcSession(id)?.isAlive(), "new background channel adoption");
  assert.equal(getRpcSession(id).hasSubscribers(), false);
  assert.equal(getRpcSession(id).isRunning(), true);
  assert.equal(opens.length, 1);
});

test("explicit v7 reload kills once, restores registrations and leaves startup settings to the daemon", async (t) => {
  const id = sessionId();
  const { link, messages, opens } = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(link.id));
  await session.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  await session.send({ type: "set_host_uri_schemes", schemes: [{ scheme: "browser", writable: true }] });
  await session.send({ type: "reload" });
  assert.equal(opens.length, 2);
  assert.deepEqual(messages.filter(message => message.type === "kill").map(message => message.force), [false]);
  await until(() => messages.filter(message => message.type === "host_tools").length >= 3, "restored tool registration");
  assert.deepEqual(messages.filter(message => message.type === "host_tools").at(-1).schemes, [{ scheme: "browser", writable: true }]);
  const forbidden = new Set(["set_host_tools", "set_host_uri_schemes"]);
  assert.deepEqual(messages.filter(message => message.type === "stdin" && forbidden.has(JSON.parse(message.line).type)), []);
});

test("a stale channel announcement cannot exit a channel opened after that snapshot", async (t) => {
  const id = sessionId();
  const { link } = await sharedLink(t, id);
  const { transport } = await hub.getHost(link.id).spawnRpc(launch(id), id);
  let exited = false;
  transport.onExit(() => { exited = true; });
  await link.post({ type: "channels_changed", channels: [] }, { type: "notifier", on: false });
  await until(() => !hub.isNotifier(link.id), "same-frame ordering marker");
  assert.equal(exited, false);
  assert.equal(transport.lost, false);
  transport.close();
});

test("a shared resync re-opens the snapshot without disposing the session", async (t) => {
  const id = sessionId();
  const { link, ch, opens, closes } = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(link.id));
  await link.post({ type: "resync", ch });
  await until(() => opens.length >= 2 || closes.length > 0, "snapshot re-open");
  await session.send({ type: "get_state" });
  assert.equal(session.isAlive(), true);
  assert.deepEqual(closes, []);
});

test("rejoining reasserts the transport's existing interest and preparation without wrapper traffic", async (t) => {
  const id = sessionId();
  const { link, messages } = await sharedLink(t, id);
  const { transport } = await hub.getHost(link.id).spawnRpc(launch(id), id);
  transport.setInterest(true);
  transport.setPreparing(true);
  await until(() => messages.filter(message => message.type === "interest").at(-1)?.preparing === true, "initial transport lease");
  const before = messages.filter(message => message.type === "interest").length;
  await transport.resync();
  await until(() => messages.filter(message => message.type === "interest").length > before, "reasserted transport lease");
  const latest = messages.filter(message => message.type === "interest").at(-1);
  assert.equal(latest.on, true);
  assert.equal(latest.preparing, true);
  transport.close();
});

test("the open-to-command preparation handoff has no false gap and is never reused by resync", async (t) => {
  const id = sessionId();
  const { link, messages, opens } = await sharedLink(t, id);
  const { transport } = await hub.getHost(link.id).spawnRpc(launch(id), id, { preparing: true });
  await until(() => messages.some(message => message.type === "interest" && message.preparing), "handoff lease");
  // An unrelated command never inherits (and so never ends) the open's lease.
  transport.setPreparing(true);
  transport.setPreparing(false);
  assert.equal(messages.filter(message => message.type === "interest").at(-1)?.preparing, true);
  transport.setPreparing(true, true);
  await transport.resync();
  assert.equal(opens.at(-1).preparing, undefined);
  assert.equal(opens.at(-1).expectedChannel, transport.id);
  assert.equal(messages.filter(message => message.type === "interest").every(message => message.preparing), true);
  transport.setPreparing(false);
  await until(() => messages.filter(message => message.type === "interest").at(-1)?.preparing === false, "command releases preparation");
  transport.close();
});

test("a stale passive announcement after native exit cannot cold-start the saved session", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id, { listed: true });
  await until(() => getRpcSession(id)?.isAlive(), "initial passive adoption");
  const ch = fixture.ch;
  await fixture.exit();
  await until(() => !getRpcSession(id), "exited wrapper removed");
  await fixture.link.post({ type: "channels_changed", channels: [{ ch, sessionId: id, cwd: "/w", pending: [] }] });
  await until(() => fixture.opens.length === 2, "stale conditional join");
  await until(() => fixture.closes.includes(ch), "stale join refused and local placeholder closed");
  assert.equal(fixture.opens.at(-1).expectedChannel, ch);
  assert.equal(fixture.coldStarts, 0);
  assert.equal(getRpcSession(id), undefined);
});

test("failed shared startup closes an unclaimed preparation handoff", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id, { fail: "get_state" });
  await assert.rejects(startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(fixture.link.id), true), /get_state failed/);
  await until(() => fixture.closes.includes(fixture.ch), "failed startup closes its leased membership");
  assert.equal(getRpcSession(id), undefined);
});

test("a peer's deliberate identity switch refreshes the joined server's registry", async (t) => {
  const id = sessionId(), next = sessionId(), state = {};
  const { link, ch } = await sharedLink(t, id, { state });
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(link.id));
  t.after(() => session.destroyAndWait());
  state.sessionId = next;
  state.sessionFile = launch(next).sessionFile;
  await link.post({ type: "channels_changed", channels: [{ ch, sessionId: next, cwd: "/w", pending: [] }] });
  await until(() => getRpcSession(next) === session, "peer switched identity");
  assert.equal(getRpcSession(id), undefined);
  assert.equal(session.isAlive(), true);
});

test("a peer server's identical echo never confirms this server's own message admission", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(fixture.link.id));
  const echo = (n) => ["message_start", "message_end"].map(type => ({ type: "stdout", ch: fixture.ch, line: ev({ type, messageId: `u${n}`, message: { role: "user", content: "same" } }) }));
  const watch = () => session.watchMessageReplacement({ type: "prompt", message: "same" }, { steering: [], followUp: [] }, session.getMessageCommandGeneration() - 1, false);
  const own = watch(), owned = own.handOff();
  await fixture.link.post(...echo(1));
  assert.deepEqual(await owned, {}, "an uncontended echo proves the admission");
  own.stop();
  const contended = watch(), outcome = contended.handOff();
  await fixture.link.post({ type: "stdout", ch: fixture.ch, line: JSON.stringify({ type: "peer_message_command" }) }, ...echo(2));
  assert.equal((await outcome).mayHaveBeenSent, true, "a peer's admission makes the echo ambiguous");
  contended.stop();
});

test("an edit another web app holds the lease for fails session_busy before any preflight read", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id, { leaseBusy: true });
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(fixture.link.id));
  const reads = () => fixture.messages.filter(message => message.type === "stdin" && JSON.parse(message.line).type === "get_state").length;
  const before = reads();
  await assert.rejects(session.send({ type: "edit_message", entryId: "u1" }), { code: "session_busy" });
  assert.equal(reads(), before, "no preflight ran without the lease");
  assert.deepEqual(fixture.leases, [true], "a lease it never got is not released");
  assert.equal(session.isEditingHistory(), false);
});

test("a pre-release v7 daemon without editLease still lets the edit run", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(fixture.link.id));
  session.proc.transport.setEditing = async () => { throw new HostOpError(501, "unknown_op", "Unknown host op: editLease"); };
  const editing = session.send({ type: "edit_message", entryId: "u1" });
  await until(() => fixture.messages.some(message => message.type === "stdin" && JSON.parse(message.line).type === "get_state" && session.isEditingHistory()), "preflight ran");
  // The fake child never answers /tau_edit: the edit itself is not this test's concern.
  editing.catch(() => {});
});

test("a host's planned stop closes the wrapper quietly; a crash is still reported", async (t) => {
  const { getExitedRpcSession } = await import("../rpc-manager.ts");
  for (const [reason, reported] of [["abandoned", false], [undefined, true]]) {
    const id = sessionId();
    const fixture = await sharedLink(t, id);
    const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, "/w", undefined, hub.getHost(fixture.link.id));
    const notices = [];
    const off = session.onEvent(event => { if (event.type === "notice" && event.level === "error") notices.push(event); });
    await fixture.link.post({ type: "exit", ch: fixture.ch, code: 143, signal: null, ...(reason ? { reason } : {}) });
    await until(() => getRpcSession(id) === undefined, "wrapper closed");
    off();
    assert.equal(Boolean(getExitedRpcSession(id)), reported);
    assert.equal(notices.length > 0, reported);
  }
});
