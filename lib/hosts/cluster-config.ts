import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

/** `manifestBytes`: the longest manifest a member reads (daemon-cluster-config.ts), as the routes serialize it. */
export const CONFIG_LIMITS = { fileBytes: 5_242_880, bundleBytes: 52_428_800, manifestBytes: 5_242_880 };

export type ConfigRoot = "agent" | "home";

/** Mirrored entries: files and directories, relative to the pi agent directory or to the home directory. */
export const MIRRORED: readonly { root: ConfigRoot; path: string; kind: "file" | "dir" }[] = [
  ...["settings.json", "models.json", "mcp.json", ".mcp.json", "AGENTS.md", "RULES.md", "SYSTEM.md", "APPEND_SYSTEM.md", "TITLE_SYSTEM.md", "secrets.yml", ".env"].map(
    (path) => ({ root: "agent" as const, path, kind: "file" as const }),
  ),
  ...["skills", "agents", "rules", "instructions", "commands", "prompts", "hooks", "extensions", "tools"].map((path) => ({
    root: "agent" as const,
    path,
    kind: "dir" as const,
  })),
  { root: "home", path: ".agents/skills", kind: "dir" },
];

/** `config.yml` key paths a member keeps for itself (spec K2). A path covers everything below it. */
export const LOCAL_SETTINGS: readonly (readonly string[])[] = [
  ["shellPath"],
  ["python", "interpreter"],
  ["browser"],
  ["worktree", "base"],
  ["plan", "autosaveDir"],
  ["shellMinimizer", "settingsPath"],
  ["mnemopi", "dbPath"],
  ["workspace", "additionalDirectories"],
  ["skills", "customDirectories"],
  ["extensions"],
  ["images", "urls"],
  ["providers", "tinyModelDevice"],
  ["providers", "tinyModelDtype"],
  ["tts"],
  ["stt"],
  ["tui"],
  ["terminal"],
  ["lsp"],
  ["auth", "broker"],
];

export interface ManifestFile { root: ConfigRoot; path: string; hash: string; size: number; exec: boolean }
/** `source` (npm only): the master's dependency spec for the plugin (`github:…`, a range, `file:…`); null for a linked plugin; absent from a master that cannot read it. */
export interface PluginEntry { kind: "npm" | "marketplace"; id: string; version: string | null; enabled: boolean; source?: string | null }
export interface ConfigManifest { version: string; files: ManifestFile[]; agentEnv: Record<string, string>; plugins: PluginEntry[] }

export class ClusterConfigError extends Error {
  constructor(readonly code: "file_too_large" | "bundle_too_large" | "invalid_settings" | "invalid_path" | "unreadable", message: string) {
    super(message);
    this.name = "ClusterConfigError";
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Runs a filesystem call; its failure becomes `unreadable`, naming the manifest path and the errno, never content. */
function io<T>(path: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new ClusterConfigError("unreadable", `${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

/** Follows symbolic links; a broken link counts as missing. */
function statOrNull(path: string, manifestPath: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return null;
    throw new ClusterConfigError("unreadable", `${manifestPath} cannot be read (${code ?? "error"})`);
  }
}

const invalidSettings = () => new ClusterConfigError("invalid_settings", "settings.json is not a valid JSON object");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSettings(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidSettings();
  }
  if (!isPlainObject(parsed)) throw invalidSettings();
  return parsed;
}

function deletePath(obj: Record<string, unknown>, path: readonly string[]): void {
  let curr: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = curr[path[i]];
    if (!isPlainObject(next)) return;
    curr = next;
  }
  delete curr[path[path.length - 1]];
}

function setPath(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let curr: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!isPlainObject(curr[key])) curr[key] = {};
    curr = curr[key] as Record<string, unknown>;
  }
  curr[path[path.length - 1]] = value;
}

export function stripLocalSettings(masterJson: string): string {
  const obj = parseSettings(masterJson);
  for (const path of LOCAL_SETTINGS) deletePath(obj, path);
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** The member's value at `path` as plain data, or undefined when absent. */
function plainAt(data: unknown, path: readonly string[]): unknown {
  let node = data;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export function mergeLocalSettings(masterJson: string, ownJson: string | null): string {
  const stripped = stripLocalSettings(masterJson);
  if (ownJson === null) return stripped;
  try {
    const own = ownJson.trim() ? JSON.parse(ownJson) : {};
    if (!isPlainObject(own)) return stripped;
    const obj = parseSettings(stripped);
    for (const path of LOCAL_SETTINGS) {
      const value = plainAt(own, path);
      if (value !== undefined) setPath(obj, path, value);
    }
    return `${JSON.stringify(obj, null, 2)}\n`;
  } catch {
    return stripped;
  }
}

export function isManagedPath(root: ConfigRoot, path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0")) return false;
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return MIRRORED.some((entry) => entry.root === root && (entry.kind === "file" ? path === entry.path : path.startsWith(`${entry.path}/`)));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Reads the mirrored entries under the two roots. `content(hash)` returns the bytes of a manifest file. */
export function buildManifest(
  roots: Record<ConfigRoot, string>,
  extra: { agentEnv: Record<string, string>; plugins: PluginEntry[] },
): { manifest: ConfigManifest; content(hash: string): Uint8Array | null } {
  const files: ManifestFile[] = [];
  const contents = new Map<string, Uint8Array>();
  let total = 0;

  const checkSize = (path: string, size: number) => {
    if (size > CONFIG_LIMITS.fileBytes) throw new ClusterConfigError("file_too_large", `${path} is ${size} bytes, over the ${CONFIG_LIMITS.fileBytes} byte limit`);
  };

  /** `source` is where the master keeps it; `path` is the manifest path (differs for `config.yaml`). */
  const addFile = (root: ConfigRoot, path: string, source: string, stat: Stats) => {
    if (!isManagedPath(root, path)) throw new ClusterConfigError("invalid_path", `${path} cannot be mirrored: its name is not a safe relative path`);
    checkSize(path, stat.size);
    let bytes: Uint8Array = io(path, () => readFileSync(source));
    if (root === "agent" && path === "settings.json") bytes = Buffer.from(stripLocalSettings(Buffer.from(bytes).toString("utf8")), "utf8");
    checkSize(path, bytes.length);
    total += bytes.length;
    if (total > CONFIG_LIMITS.bundleBytes) throw new ClusterConfigError("bundle_too_large", `the bundle exceeds ${CONFIG_LIMITS.bundleBytes} bytes at ${path}`);
    const hash = sha256(bytes);
    contents.set(hash, bytes);
    files.push({ root, path, hash, size: bytes.length, exec: (stat.mode & 0o100) !== 0 });
  };

  // `walking` holds the real paths of the directories being walked, so a link back to an ancestor is skipped.
  const walk = (root: ConfigRoot, path: string, dir: string, walking: Set<string>) => {
    const real = io(path, () => realpathSync(dir));
    if (walking.has(real)) return;
    walking.add(real);
    for (const name of io(path, () => readdirSync(dir))) {
      if (name === ".git") continue; // a directory, or a file in a worktree or submodule
      const source = join(dir, name);
      const stat = statOrNull(source, `${path}/${name}`);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (name !== "node_modules") walk(root, `${path}/${name}`, source, walking);
      } else if (stat.isFile()) addFile(root, `${path}/${name}`, source, stat);
    }
    walking.delete(real);
  };

  for (const entry of MIRRORED) {
    const base = join(roots[entry.root], entry.path);
    if (entry.kind === "dir") {
      if (statOrNull(base, entry.path)?.isDirectory()) walk(entry.root, entry.path, base, new Set());
      continue;
    }
    const stat = statOrNull(base, entry.path);
    if (stat?.isFile()) addFile(entry.root, entry.path, base, stat);
  }

  files.sort((a, b) => compare(a.root, b.root) || compare(a.path, b.path));
  const plugins = [...extra.plugins].sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
  const agentEnv = Object.fromEntries(Object.keys(extra.agentEnv).sort().map((key) => [key, extra.agentEnv[key]]));
  const version = sha256(canonicalJson({ files, agentEnv, plugins }));
  const manifest = { version, files, agentEnv, plugins };
  // Empty files add entries but no bytes to the bundle: their count alone can make the manifest longer than a member reads.
  if (Buffer.byteLength(JSON.stringify(manifest)) > CONFIG_LIMITS.manifestBytes) {
    throw new ClusterConfigError("bundle_too_large", `too many files to mirror (${files.length}): their list exceeds ${CONFIG_LIMITS.manifestBytes} bytes`);
  }
  return { manifest, content: (hash) => contents.get(hash) ?? null };
}
