// Host daemon only (Node, loaded through jiti): relative imports, `node:*` modules and the global fetch, no `Bun` global.
// A cluster member runs on the master's pi configuration (docs/specs/2026-11-11-cluster-configuration-design.md, K3-K6):
// a version is applied whole or not at all, and the member's own configuration waits in `own-config/` until it leaves.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../type-guards";
import { loadWebServerSettings, saveWebServerSettings } from "../web-settings";
import { CONFIG_LIMITS, isManagedPath, mergeLocalSettings, MIRRORED, type ConfigManifest, type ConfigRoot, type ManifestFile } from "./cluster-config";
import { HostOpError } from "./link-protocol";

export interface ConfigState { version: string | null; files: "none" | "current" | "failed"; error: string | null; missingCommands: string[] }
/** Every request to the master, its body included, must finish within `fetchMs`. Tests shorten it. */
export const clusterConfigTimings = { fetchMs: 30_000 };

const API = "/api/hosts/cluster-config/";
const HASH_RE = /^[0-9a-f]{64}$/;

/** A failure whose message is safe to report and log: paths and statuses, never content. */
class ApplyError extends Error {}
const fail = (reason: string): never => {
  throw new ApplyError(reason);
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const removeAll = (path: string) => rmSync(path, { recursive: true, force: true });
/** Answers the topmost directory it created, if any. */
const makeDir = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });
const quietly = (step: () => void) => {
  try {
    step();
    return true;
  } catch {
    return false;
  }
};

/** `rename`, which moves a link as a link. It cannot cross filesystems: the reason then names the two directories. */
function move(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") fail(`${dirname(from)} and ${dirname(to)} are on different filesystems; cluster configuration needs them on one filesystem`);
    throw error;
  }
}

/** Written under a fresh name beside `path`, then renamed over it: never half a file, never written through a link at `path`. */
function writeAtomic(path: string, data: string | Uint8Array, mode = 0o600) {
  makeDir(dirname(path));
  const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, data, { mode, flag: "wx" });
    chmodSync(temp, mode); // the umask may have narrowed it
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** JSON without the parser's own message, which quotes the input (the manifest and the backup hold secrets). */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what} is not valid JSON`);
  }
}

const isFile = (f: unknown): f is ManifestFile =>
  isRecord(f) &&
  (f.root === "agent" || f.root === "home") &&
  typeof f.path === "string" &&
  typeof f.hash === "string" &&
  HASH_RE.test(f.hash) &&
  typeof f.size === "number" &&
  Number.isSafeInteger(f.size) &&
  f.size >= 0 &&
  f.size <= CONFIG_LIMITS.fileBytes &&
  typeof f.exec === "boolean";

/** The master's manifest, checked whole before anything touches the disk. */
function checkManifest(value: unknown): ConfigManifest {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !HASH_RE.test(value.version) ||
    !Array.isArray(value.files) ||
    !value.files.every(isFile) ||
    !isRecord(value.agentEnv) ||
    !Object.values(value.agentEnv).every((v) => typeof v === "string")
  ) {
    return fail("the master's manifest is malformed");
  }
  const manifest = value as unknown as ConfigManifest;
  let total = 0;
  for (const file of manifest.files) {
    if (!isManagedPath(file.root, file.path)) fail(`the manifest names ${file.root}:${JSON.stringify(file.path)}, which is not a mirrored path`);
    total += file.size;
  }
  if (total > CONFIG_LIMITS.bundleBytes) fail(`the manifest exceeds ${CONFIG_LIMITS.bundleBytes} bytes`);
  return manifest;
}

/** The body, refused as soon as it passes `limit` bytes. */
async function readBody(res: Response, limit: number, tooLong: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      fail(tooLong);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Whether a member's own settings file is something `mergeLocalSettings` can keep values from. */
function readsAsObject(json: string): boolean {
  if (!json.trim()) return true;
  try {
    return isRecord(JSON.parse(json));
  } catch {
    return false;
  }
}

/** The member's own `settings.json` in `dir`, or null without one. */
function ownSettings(dir: string): { path: string; json: string } | null {
  const path = join(dir, "settings.json");
  try {
    return { path, json: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export function createClusterConfig(deps: {
  roots(): Record<ConfigRoot, string>;
  stateDir(): string; // <agent dir>/tau
  fetch(serverUrl: string, path: string, signal: AbortSignal): Promise<Response>; // authenticated by the caller; path starts with /api/hosts/cluster-config/
  commandExists(command: string): Promise<boolean>;
  onState(state: ConfigState): void; // also when the server holding the configuration changes: see holds()
  /** Whether `serverUrl` is one of this daemon's configured links (host.json), connected or not. */
  isLinked(serverUrl: string): boolean;
  log(message: string): void;
}) {
  let applied: { version: string } | null = null;
  let files: ConfigState["files"] = "none";
  let filesError: string | null = null;
  let missingCommands: string[] = [];
  let stopped = false;
  // Restores called and not yet finished: while one is, ensure is refused.
  let restoring = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const inflight = new Map<string, Promise<void>>();
  /** Aborts every request to the master at stop(). */
  const halt = new AbortController();
  /** Servers whose leave (`restore`) came after their last `apply`: a start one of them sent before it never applies again. */
  const left = new Set<string>();
  /** The server whose configuration this host holds, from its first apply until its restore (`own-config/server.json`): one cluster per host. */
  let owner: string | null = null;

  const state = (): ConfigState => ({ version: applied?.version ?? null, files, error: filesError, missingCommands: [...missingCommands] });
  const report = () => deps.onState(state());
  // A holder this daemon no longer links to (re-linked at a new address, or removed) holds nothing back: the server asking takes over.
  const foreign = (serverUrl: string) =>
    owner !== null && owner !== serverUrl && deps.isLinked(owner) ? `This host runs the cluster configuration of ${owner}; it must leave that cluster first` : null;
  /**
   * Whether `serverUrl` decides over the configuration this host holds: it is the recorded holder, or that holder is no
   * longer linked, so its apply takes the host over and its restore puts the member's own back.
   */
  const holds = (serverUrl: string) => owner !== null && foreign(serverUrl) === null;
  const dirs = () => {
    const cc = join(deps.stateDir(), "cluster-config");
    return { cc, objects: join(cc, "objects"), stage: join(cc, "stage"), trash: join(cc, "trash"), stateFile: join(cc, "state.json"), own: join(deps.stateDir(), "own-config") };
  };
  /** Applies, restores and MCP command checks run one at a time in call order: a restore never races an apply. */
  const enqueue = (job: () => Promise<void>) => {
    const run = queue.then(job);
    queue = run.catch(() => undefined);
    return run;
  };

  function failure(error: unknown, what: string): HostOpError {
    if (error instanceof HostOpError) return error; // reported where it was raised
    const reason = messageOf(error);
    files = "failed";
    filesError = reason;
    report();
    deps.log(`cluster-config: ${what} failed: ${reason}`);
    return new HostOpError(409, "cluster_config_failed", reason);
  }

  /** The applied files are the asked version's: a failure of another version no longer counts. */
  function current() {
    if (files === "current" && filesError === null) return;
    files = "current";
    filesError = null;
    report();
  }

  /** A request to the master: answered, body included, within clusterConfigTimings.fetchMs, and cut short by stop(). */
  async function fromMaster<T>(serverUrl: string, path: string, what: string, read: (res: Response) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([halt.signal, AbortSignal.timeout(clusterConfigTimings.fetchMs)]);
    try {
      return await read(await deps.fetch(serverUrl, path, signal));
    } catch (error) {
      if (!signal.aborted) throw error;
      return fail(stopped ? "the host daemon is stopping" : `the master did not send ${what} within ${clusterConfigTimings.fetchMs / 1000} s`);
    }
  }

  async function fetchManifest(serverUrl: string): Promise<ConfigManifest> {
    const body = await fromMaster(serverUrl, `${API}manifest`, "the manifest", async (res) => {
      if (!res.ok) {
        await res.body?.cancel();
        fail(`the master answered ${res.status} for the manifest`);
      }
      return readBody(res, CONFIG_LIMITS.manifestBytes, `the manifest is longer than ${CONFIG_LIMITS.manifestBytes} bytes`);
    });
    return checkManifest(parseJson(body.toString("utf8"), "the manifest"));
  }

  /** Every file of `manifest` in `objects/`, verified before it enters; false when the master no longer has one (404). */
  async function download(serverUrl: string, manifest: ConfigManifest): Promise<boolean> {
    const { objects } = dirs();
    for (const file of manifest.files) {
      if (stopped) fail("the host daemon is stopping");
      const target = join(objects, file.hash);
      if (exists(target)) continue;
      const bytes = await fromMaster(serverUrl, `${API}file/${file.hash}`, file.path, async (res) => {
        if (res.ok) return readBody(res, file.size, `${file.path} is longer than the manifest says`);
        await res.body?.cancel();
        return res.status === 404 ? null : fail(`the master answered ${res.status} for ${file.path}`);
      });
      if (bytes === null) return false;
      if (createHash("sha256").update(bytes).digest("hex") !== file.hash) fail(`${file.path} does not match its hash`);
      writeAtomic(target, bytes);
    }
    return true;
  }

  function mergedSettings(master: string, own: { path: string; json: string } | null): string {
    if (own && !readsAsObject(own.json)) deps.log(`cluster-config: ${own.path} cannot be read as settings; this host's own machine-specific settings were not kept`);
    return mergeLocalSettings(master, own?.json ?? null);
  }

  /**
   * Steps 4-6. The first apply moves the member's own entries into `own-config/` where later ones move the previous
   * version to `trash/`. The backup, the swaps, the agent environment and `state.json` are one transaction: on any
   * failure everything moved is put back, so the member keeps exactly what it had. A backup without `state.json` (a
   * stop in the middle, or a failure that could not put everything back) is put back before the next apply.
   * `serverUrl`: the server whose configuration a first apply takes.
   */
  function install(manifest: ConfigManifest, first: boolean, serverUrl: string) {
    const d = dirs();
    const roots = deps.roots();
    const aside = first ? d.own : d.trash;
    refuseLinkedParents(roots);
    const undo: (() => void)[] = [];
    let previousState: Buffer | null = null;
    try {
      removeAll(d.stage);
      removeAll(d.trash);
      // Step 5. On the first apply the member's settings are still live, about to become the backup; read through a link
      // there and kept as a plain copy, since a relative link no longer resolves once it is moved.
      const settingsCopy = join(d.own, "settings.json");
      const own = first ? ownSettings(roots.agent) : exists(settingsCopy) ? { path: settingsCopy, json: readFileSync(settingsCopy, "utf8") } : null;
      let settings = false;
      for (const file of manifest.files) {
        const bytes = readFileSync(join(d.objects, file.hash));
        const isSettings = file.root === "agent" && file.path === "settings.json";
        settings ||= isSettings;
        writeAtomic(join(d.stage, file.root, file.path), isSettings ? mergedSettings(bytes.toString("utf8"), own) : bytes, file.exec ? 0o700 : 0o600);
      }
      // Without a master settings.json the member still keeps its machine-specific keys (K2).
      if (!settings && own) writeAtomic(join(d.stage, "agent", "settings.json"), mergedSettings("", own));

      const previousEnv = loadWebServerSettings().agentEnv;
      if (first) {
        // absent.json last: once it exists, entries may have moved, and a restore puts them back.
        if (own) writeAtomic(settingsCopy, own.json);
        writeAtomic(join(d.own, "agent-env.json"), JSON.stringify(previousEnv));
        writeAtomic(join(d.own, "server.json"), JSON.stringify(serverUrl));
        owner = serverUrl;
        // Absent entries, and their missing parents, are noted: a restore removes them.
        const absent: [ConfigRoot, string][] = [];
        for (const entry of MIRRORED) {
          for (let path = entry.path; path !== "."; path = dirname(path)) if (!exists(join(roots[entry.root], path))) absent.push([entry.root, path]);
        }
        writeAtomic(join(d.own, "absent.json"), JSON.stringify(absent));
      } else {
        // Until the new state.json no version counts as applied, so a stop during the swaps leaves a backup to put back.
        previousState = readFileSync(d.stateFile);
        rmSync(d.stateFile);
      }
      // Step 6. Renames move links as links: nothing is ever written through one.
      for (const entry of MIRRORED) {
        const live = join(roots[entry.root], entry.path);
        const staged = join(d.stage, entry.root, entry.path);
        if (exists(live)) {
          const away = join(aside, entry.root, entry.path);
          makeDir(dirname(away));
          move(live, away);
          undo.push(() => move(away, live));
        }
        if (exists(staged)) {
          const created = makeDir(dirname(live));
          if (created) undo.push(() => removeAll(created));
          move(staged, live);
          undo.push(() => removeAll(live));
        }
      }
      saveWebServerSettings({ agentEnv: manifest.agentEnv });
      undo.push(() => saveWebServerSettings({ agentEnv: previousEnv }));
      writeAtomic(d.stateFile, JSON.stringify({ version: manifest.version }));
    } catch (error) {
      const saved = previousState;
      const intact = undo.reverse().map(quietly).every(Boolean) && (saved === null || quietly(() => writeAtomic(d.stateFile, saved)));
      quietly(() => removeAll(d.stage));
      if (!intact) {
        // What could not be put back stays where it was moved; the member's own files are all in the backup.
        applied = null;
        fail(`${messageOf(error)}; the previous files could not all be put back: the next apply, or leaving the cluster, first restores this host's own configuration from ${d.own}`);
      }
      if (first) quietly(clearBackup);
      quietly(() => removeAll(d.trash));
      throw error;
    }
  }

  /** Steps 1-6. Answers whether new files were applied. */
  async function applyFiles(version: string, serverUrl: string): Promise<boolean> {
    if (stopped) fail("the host daemon is stopping");
    // Another server's first apply came earlier in the queue. Not reported: the state this host reports is that server's.
    const held = foreign(serverUrl);
    if (held) throw new HostOpError(409, "cluster_config_failed", held);
    if (applied?.version === version) {
      adopt(serverUrl);
      current();
      return false;
    }
    const d = dirs();
    // An apply or a restore that stopped half-way: the member's own files go back first, so the new backup takes them.
    if (exists(d.own) && !exists(d.stateFile)) restoreFiles();
    // A file the master no longer has means its configuration changed since the manifest: one more try with the new one.
    let manifest = await fetchManifest(serverUrl);
    if (manifest.version !== applied?.version && !(await download(serverUrl, manifest))) {
      manifest = await fetchManifest(serverUrl);
      if (manifest.version !== applied?.version && !(await download(serverUrl, manifest))) fail("the master's configuration changed during the download");
    }
    if (manifest.version === applied?.version) {
      adopt(serverUrl);
      current();
      return false;
    }
    install(manifest, !exists(d.stateFile), serverUrl);
    adopt(serverUrl);
    applied = { version: manifest.version };
    files = "current";
    filesError = null;
    try {
      removeAll(d.trash);
      removeAll(d.stage);
      const keep = new Set(manifest.files.map((file) => file.hash));
      if (exists(d.objects)) for (const name of readdirSync(d.objects)) if (!keep.has(name)) removeAll(join(d.objects, name));
    } catch (error) {
      deps.log(`cluster-config: cleaning up after the apply failed (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    report();
    return true;
  }

  /** The `command` of every server in the mirrored MCP files that this host lacks. Diagnostic only. */
  async function missingMcpCommands(): Promise<string[]> {
    const commands = new Set<string>();
    let servers: unknown;
    try {
      servers = JSON.parse(readFileSync(join(deps.roots().agent, "mcp.json"), "utf8")).mcpServers;
    } catch {
      servers = null; // absent or unreadable: pi reports it itself
    }
    if (isRecord(servers)) for (const server of Object.values(servers)) if (isRecord(server) && typeof server.command === "string" && server.command.trim()) commands.add(server.command.trim());
    const missing: string[] = [];
    for (const command of commands) if (!(await deps.commandExists(command))) missing.push(command);
    return missing;
  }

  /**
   * The applied configuration is `serverUrl`'s from here on (the holder recorded before is not linked any more, or none
   * was recorded). Best effort: unrecorded, the next apply records it, and meanwhile the hub hears it is not its own.
   */
  function adopt(serverUrl: string) {
    if (owner === serverUrl) return;
    try {
      writeAtomic(join(dirs().own, "server.json"), JSON.stringify(serverUrl));
    } catch (error) {
      deps.log(`cluster-config: the backup's server.json cannot be written (${(error as NodeJS.ErrnoException).code ?? "error"})`);
      return;
    }
    owner = serverUrl;
    report();
  }

  /** In the queue after the files, without the caller waiting for it. */
  async function checkMcpCommands() {
    const missing = await missingMcpCommands().catch(() => missingCommands);
    if (stopped || applied === null || JSON.stringify(missing) === JSON.stringify(missingCommands)) return;
    missingCommands = missing;
    report();
  }

  /** A link above an entry (`~/.agents`) would take the member's files and the master's somewhere else: refused before anything moves. */
  function refuseLinkedParents(roots: Record<ConfigRoot, string>) {
    for (const entry of MIRRORED) {
      for (let path = dirname(entry.path); path !== "."; path = dirname(path)) {
        const dir = join(roots[entry.root], path);
        if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fail(`${dir} is a symbolic link; cluster configuration needs a real directory there: replace the link with a directory`);
      }
    }
  }

  /** Empties the backup, `absent.json` first (without it nothing counts as moved), then the server it was taken for. */
  function clearBackup() {
    const { own } = dirs();
    rmSync(join(own, "absent.json"), { force: true });
    rmSync(join(own, "server.json"), { force: true });
    owner = null;
    removeAll(own);
  }

  /**
   * Puts the member's own entries and agent environment back. Run again after it stopped half-way, it finishes:
   * `absent.json` goes once every entry is back.
   */
  function restoreFiles() {
    const d = dirs();
    const roots = deps.roots();
    refuseLinkedParents(roots);
    // Before anything moves: from here on no version counts as applied, now or after a restart.
    applied = null;
    rmSync(d.stateFile, { force: true });
    // Without absent.json nothing is to move: the backup stopped before its first move, or its entries are back already.
    const absentFile = join(d.own, "absent.json");
    if (exists(absentFile)) {
      const absent = parseJson(readFileSync(absentFile, "utf8"), "the backup's absent.json") as [ConfigRoot, string][];
      for (const entry of MIRRORED) {
        const live = join(roots[entry.root], entry.path);
        const saved = join(d.own, entry.root, entry.path);
        // Neither saved nor absent: never moved (an apply stopped before it), or already put back.
        if (exists(saved)) {
          removeAll(live);
          makeDir(dirname(live));
          move(saved, live);
        } else if (absent.some(([root, path]) => root === entry.root && path === entry.path)) removeAll(live);
      }
      // Parents an apply created; rmdir leaves one that has since gained other content.
      for (const [root, path] of absent) if (!MIRRORED.some((entry) => entry.root === root && entry.path === path)) quietly(() => rmdirSync(join(roots[root], path)));
      saveWebServerSettings({ agentEnv: parseJson(readFileSync(join(d.own, "agent-env.json"), "utf8"), "the backup's agent-env.json") as Record<string, string> });
      rmSync(absentFile);
    }
  }

  /** The member's own files: a leave of `leaving`, or (null) the restore at the start that finishes an apply or a restore cut short. */
  async function restoreNow(leaving: string | null) {
    const d = dirs();
    if (!exists(d.own)) return;
    // Only the server it reports holding the configuration (holds) puts it back; for any other this changes nothing.
    if (leaving !== null && !holds(leaving)) return;
    if (stopped) throw failure(new Error("the host daemon is stopping"), "restoring");
    try {
      restoreFiles();
      clearBackup();
      removeAll(d.cc);
    } catch (error) {
      throw failure(error, "restoring");
    }
    files = "none";
    filesError = null;
    missingCommands = [];
    report();
  }

  // At the start: the server whose configuration the backup was taken for; a backup without an applied version (an apply
  // or a restore stopped half-way) is put back.
  try {
    const value = parseJson(readFileSync(join(dirs().own, "server.json"), "utf8"), "the backup's server.json");
    owner = typeof value === "string" ? value : fail("the backup's server.json is malformed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.log(`cluster-config: ${messageOf(error)}; no server counts as holding this host's configuration`);
  }
  let saved: unknown = null;
  try {
    saved = JSON.parse(readFileSync(dirs().stateFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.log("cluster-config: state.json cannot be read; no version counts as applied");
  }
  if (isRecord(saved) && typeof saved.version === "string") {
    applied = { version: saved.version };
    files = "current";
    enqueue(checkMcpCommands).catch((error) => deps.log(`cluster-config: ${messageOf(error)}`));
  } else if (exists(dirs().own)) {
    enqueue(() => restoreNow(null)).catch((error) => deps.log(`cluster-config: ${messageOf(error)}`));
  }

  const refuse = (message: string) => Promise.reject(new HostOpError(409, "cluster_config_failed", message));

  /**
   * A session start's version, from the server `serverUrl` that opens it: resolves once the files of `version` are
   * applied; rejects with HostOpError(409, "cluster_config_failed", reason) otherwise. Concurrent calls share one apply.
   * Refused after that server's restore until its next apply, and while another server's configuration is held.
   */
  function ensure(version: string, serverUrl: string): Promise<void> {
    // A leave in progress is final: re-applying after it would put the master's files back.
    if (restoring > 0) return refuse("This host is leaving the cluster");
    // A start the server sent before its leave, still on its way here.
    if (left.has(serverUrl)) return refuse("This host has left the cluster");
    const held = foreign(serverUrl);
    if (held) return refuse(held);
    // Only for the recorded holder: another one adopts it first, in the queue.
    if (applied?.version === version && owner === serverUrl) {
      current();
      return Promise.resolve();
    }
    const key = JSON.stringify([serverUrl, version]);
    const shared = inflight.get(key);
    if (shared) return shared;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    inflight.set(key, promise);
    enqueue(async () => {
      let changed: boolean;
      try {
        changed = await applyFiles(version, serverUrl);
      } catch (error) {
        reject(failure(error, "applying"));
        return;
      } finally {
        if (inflight.get(key) === promise) inflight.delete(key);
      }
      resolve();
      // Still in the queue: a later restore waits for the check, the caller does not.
      if (changed) await checkMcpCommands();
    }).catch((error) => deps.log(`cluster-config: ${messageOf(error)}`));
    return promise;
  }

  return {
    ensure,
    /** The server's own request (`clusterConfig apply`): this host is its member again, so its starts apply again. */
    apply(version: string, serverUrl: string): Promise<void> {
      left.delete(serverUrl);
      return ensure(version, serverUrl);
    },
    /** `serverUrl` no longer counts this host as a member: its configuration gives way to the member's own; another server's stays. */
    restore(serverUrl: string): Promise<void> {
      left.add(serverUrl);
      // Another server's configuration: nothing to put back, and that server's starts are not refused while the queue runs.
      if (foreign(serverUrl)) return Promise.resolve();
      restoring++;
      return enqueue(() => restoreNow(serverUrl)).finally(() => {
        restoring--;
      });
    },
    state,
    holds,
    async stop(): Promise<void> {
      stopped = true;
      halt.abort();
      await queue;
    },
  };
}
