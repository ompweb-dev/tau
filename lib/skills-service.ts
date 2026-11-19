import { execFile } from "child_process";
import { existsSync, promises as fs, readFileSync, type Dirent } from "fs";
import { homedir } from "os";
import * as path from "path";
import { promisify } from "util";
import { parse as parseYaml } from "yaml";
import { existingPathWithinRootsChecker, getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { resolvePiBin, wrapWindowsScript } from "@/lib/omp/omp-cli";
import { ensureAgentDir, getAgentDir } from "@/lib/omp/paths";
import { parsePiListOutput } from "@/lib/omp/plugins-cli";
import { createChildProcessEnvironment } from "@/lib/project-command-env";
import { registeredProjectFor } from "@/lib/worktree";
import type { SkillInfo } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";

/**
 * Pure-Node skill discovery mirroring pi 1.5.2 (dist/core/package-manager.js `resolve` and
 * `addAutoDiscoveredResources`, dist/core/skills.js `loadSkills`). tau never imports pi's SDK, so the rules are
 * replicated: the sources are read in pi's precedence order (`resourcePrecedenceRank`), the first skill of a name
 * wins, and a file reached twice (a symlink) counts once.
 */

export interface SkillDiagnostic {
  type: "error" | "warning" | "info";
  message: string;
  path?: string;
}

export interface SkillsWithDiagnostics {
  skills: SkillInfo[];
  diagnostics: SkillDiagnostic[];
}

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Split YAML frontmatter from a markdown document. Returns an empty
 * frontmatter object when no `---` block is present or YAML is invalid. */
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(match[1]) as unknown;
    const frontmatter =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return { frontmatter, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

/** The only key pi reads (skills.js `loadSkillFromFile`), and only a YAML `true`. */
const DISABLE_KEY = "disable-model-invocation";

export function readDisableModelInvocation(frontmatter: Record<string, unknown>): boolean {
  return frontmatter[DISABLE_KEY] === true;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const DISABLE_KEY_LINE_RE = new RegExp(`^${DISABLE_KEY}[ \\t]*:.*$`);

/** Set/clear the disable-model-invocation flag in a SKILL.md, editing the key
 * line already present instead of prepending a second copy, which would make
 * the frontmatter invalid YAML. */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return disable ? `---\n${DISABLE_KEY}: true\n---\n${content}` : content;
  }

  const eol = match[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = match[1].split(/\r?\n/);
  const hits = lines.reduce<number[]>((acc, line, index) => {
    if (DISABLE_KEY_LINE_RE.test(line)) acc.push(index);
    return acc;
  }, []);

  let next: string[];
  if (disable) {
    next = hits.length === 0
      ? [`${DISABLE_KEY}: true`, ...lines]
      : lines.map((line, index) => (index === hits[0] ? `${DISABLE_KEY}: true` : line)).filter((_, index) => !hits.includes(index) || index === hits[0]);
  } else {
    if (hits.length === 0) return content;
    next = lines.filter((_, index) => !hits.includes(index));
  }

  const block = `---${eol}${next.join(eol)}${eol}---${match[2]}`;
  return block + content.slice(match[0].length);
}

type ScanMode = "pi" | "agents";
interface SkillSource {
  /** Files or directories, as pi resolves them for this source. */
  paths: string[];
  /** Directories are walked with collectSkillEntries in this mode; files are taken as they are. */
  mode: ScanMode;
  /** sourceInfo.source: ".pi", ".agents", "settings", or the package source. */
  source: string;
  scope: "user" | "project";
}

/** pi's `collectAncestorAgentsSkillDirs`: `.agents/skills` from cwd up to the git root, or the filesystem root
 * outside a repository, without the user's own `~/.agents/skills`. */
function ancestorAgentsSkillDirs(cwd: string): string[] {
  const userDir = path.join(homedir(), ".agents", "skills");
  const dirs: string[] = [];
  const start = path.resolve(cwd);
  let gitRoot: string | null = null;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) { gitRoot = dir; break; }
    if (path.dirname(dir) === dir) break;
  }
  for (let dir = start; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, ".agents", "skills");
    if (candidate !== userDir) dirs.push(candidate);
    if (dir === gitRoot || path.dirname(dir) === dir) break;
  }
  return dirs;
}

/** The `skills` entries of a pi settings.json, resolved against `baseDir` (`~` is the home directory). */
function settingsSkillPaths(settingsFile: string, baseDir: string): string[] {
  let entries: unknown;
  try { entries = (JSON.parse(readFileSync(settingsFile, "utf8")) as { skills?: unknown }).skills; } catch { return []; }
  if (!Array.isArray(entries)) return [];
  // shortcut: pi's `!`/`+`/`-` and glob entries (filters over the auto-discovered skills) are not applied; add them
  // if users rely on them to hide skills.
  return entries
    .filter((entry): entry is string => typeof entry === "string" && !/^[!+-]|[*?]/.test(entry.trim()))
    .map((entry) => {
      const trimmed = entry.trim();
      const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? path.join(homedir(), trimmed.slice(2)) : trimmed;
      return path.resolve(baseDir, expanded);
    });
}

/** pi's `collectPackageResources` for skills: the `pi.skills` entries of package.json, else its `skills/` directory. */
function packageSkillPaths(root: string): string[] {
  let manifest: Record<string, unknown> | undefined;
  try {
    const pi = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { pi?: unknown }).pi;
    if (pi && typeof pi === "object" && !Array.isArray(pi)) manifest = pi as Record<string, unknown>;
  } catch { /* no manifest: the convention directory */ }
  if (!manifest || !["extensions", "skills", "prompts", "themes"].some((key) => manifest[key] !== undefined)) return [path.join(root, "skills")];
  const entries = Array.isArray(manifest.skills) ? manifest.skills : [];
  // shortcut: glob and `!`/`+`/`-` manifest entries and a package's settings filter are not applied.
  return entries.filter((entry): entry is string => typeof entry === "string" && !/^[!+-]|[*?]/.test(entry)).map((entry) => path.resolve(root, entry));
}

const execFileAsync = promisify(execFile);
const PI_LIST_TIMEOUT_MS = 30_000;

/** Installed package directories as `pi list` prints them (run in cwd), project packages first as pi orders them. */
async function installedPackages(cwd: string, piBin: string | null, diagnostics: SkillDiagnostic[]) {
  if (!piBin) return [];
  // The directory goes in as the process cwd, never as an argument: cmd.exe would interpret `&` in it.
  const target = wrapWindowsScript(piBin, ["list"]);
  try {
    const { stdout } = await execFileAsync(target.file, target.args, {
      cwd: path.resolve(cwd),
      timeout: PI_LIST_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      // Otherwise this child inherits the server's full environment, including tau's own secrets.
      env: createChildProcessEnvironment({ FORCE_COLOR: "0", NO_COLOR: "1" }),
    });
    const listed = parsePiListOutput(stdout).filter((pkg) => pkg.path);
    return [...listed.filter((pkg) => pkg.scope === "project"), ...listed.filter((pkg) => pkg.scope === "global")];
  } catch (error) {
    diagnostics.push({ type: "warning", message: `pi list failed; package skills are not listed: ${error instanceof Error ? error.message : String(error)}` });
    return [];
  }
}

/**
 * Whether a session tau starts in cwd loads the project's .pi and .agents resources: tau passes `--approve` inside a
 * registered workspace (lib/hosts/local-host.ts projectTrustArgs); elsewhere pi decides as it does in rpc mode, which
 * has no prompt: the nearest trust.json entry, else `defaultProjectTrust` "always" (pi's core/project-trust.js).
 * shortcut: trust.json keys are compared as exact strings (pi folds case on Windows), and a `project_trust`
 * extension handler is not consulted.
 */
async function projectTrusted(cwd: string): Promise<boolean> {
  if (await registeredProjectFor(cwd)) return true;
  const read = (file: string): Record<string, unknown> => {
    try { return JSON.parse(readFileSync(path.join(getAgentDir(), file), "utf8")) ?? {}; } catch { return {}; }
  };
  const trust = read("trust.json");
  let dir = path.resolve(cwd);
  try { dir = await fs.realpath(dir); } catch { /* pi falls back to the resolved path too */ }
  for (;; dir = path.dirname(dir)) {
    if (typeof trust[dir] === "boolean") return trust[dir] as boolean;
    if (path.dirname(dir) === dir) break;
  }
  return read("settings.json").defaultProjectTrust === "always";
}

/** Skill sources for cwd in pi's precedence order: project settings, project auto-discovery, user settings, user
 * auto-discovery, packages. `scope` "user", or a project pi would not trust, leaves the project ones out. */
async function skillSources(cwd: string, piBin: string | null, diagnostics: SkillDiagnostic[], scope?: "user"): Promise<SkillSource[]> {
  const agentDir = getAgentDir();
  const projectBase = path.join(path.resolve(cwd), ".pi");
  const sources: SkillSource[] = [];
  const trusted = !scope && await projectTrusted(cwd);
  const projectPaths = [path.join(projectBase, "settings.json"), path.join(projectBase, "skills"), ...ancestorAgentsSkillDirs(cwd)];
  if (!scope && !trusted && projectPaths.some((entry) => existsSync(entry))) {
    diagnostics.push({ type: "info", message: "pi does not trust this folder, so its project skills are not loaded: add it as a workspace, or trust it in pi." });
  }
  if (trusted) {
    sources.push({ paths: settingsSkillPaths(path.join(projectBase, "settings.json"), projectBase), mode: "pi", source: "settings", scope: "project" });
    sources.push({ paths: [path.join(projectBase, "skills")], mode: "pi", source: ".pi", scope: "project" });
    sources.push({ paths: ancestorAgentsSkillDirs(cwd), mode: "agents", source: ".agents", scope: "project" });
  }
  sources.push({ paths: settingsSkillPaths(path.join(agentDir, "settings.json"), agentDir), mode: "pi", source: "settings", scope: "user" });
  sources.push({ paths: [path.join(agentDir, "skills")], mode: "pi", source: ".pi", scope: "user" });
  sources.push({ paths: [path.join(homedir(), ".agents", "skills")], mode: "agents", source: ".agents", scope: "user" });
  for (const pkg of await installedPackages(cwd, piBin, diagnostics)) {
    if (!trusted && pkg.scope === "project") continue;
    sources.push({ paths: packageSkillPaths(pkg.path), mode: "pi", source: pkg.source, scope: pkg.scope === "project" ? "project" : "user" });
  }
  return sources;
}

/** Directories the auto-discovery reads (no settings entries, no packages: those belong to their installer), for
 * callers that must authorize a skill path. Without a cwd only the user directories. */
export function getSkillScanRootDirs(cwd?: string): string[] {
  const roots = [path.join(getAgentDir(), "skills"), path.join(homedir(), ".agents", "skills")];
  if (cwd) roots.push(path.join(path.resolve(cwd), ".pi", "skills"), ...ancestorAgentsSkillDirs(cwd));
  return roots;
}

async function entryKind(full: string, entry: Dirent): Promise<{ dir: boolean; file: boolean } | null> {
  if (!entry.isSymbolicLink()) return { dir: entry.isDirectory(), file: entry.isFile() };
  try {
    const stats = await fs.stat(full);
    return { dir: stats.isDirectory(), file: stats.isFile() };
  } catch {
    return null; // A broken symlink.
  }
}

/** pi's `collectSkillEntries`: a directory holding SKILL.md is one skill and is not descended; otherwise `.md` files
 * count at the root in "pi" mode and only below it in "agents" mode, and subdirectories are walked (dot entries and
 * node_modules skipped). shortcut: pi's .gitignore/.ignore/.fdignore rules are not applied. */
async function collectSkillEntries(dir: string, mode: ScanMode, root = dir): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const kinds = await Promise.all(entries.map((entry) => entryKind(path.join(dir, entry.name), entry)));
  if (entries.some((entry, index) => entry.name === "SKILL.md" && kinds[index]?.file)) return [path.join(dir, "SKILL.md")];
  const found: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const kind = kinds[index];
    if (!kind || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (kind.file && entry.name.endsWith(".md") && (mode === "pi" ? dir === root : dir !== root)) found.push(full);
    else if (kind.dir) found.push(...await collectSkillEntries(full, mode, root));
  }
  return found;
}

/** pi's `loadSkillFromFile`: the name is the frontmatter `name` or the parent directory's; no description, no skill. */
async function loadSkillFile(filePath: string, source: SkillSource, diagnostics: SkillDiagnostic[]): Promise<SkillInfo | null> {
  if (!filePath.endsWith(".md")) {
    diagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: filePath });
    return null;
  }
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : "failed to read skill file", path: filePath });
    return null;
  }
  const { frontmatter } = parseSkillFrontmatter(content);
  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") {
    if (path.basename(filePath) === "SKILL.md") diagnostics.push({ type: "warning", message: "description is required", path: filePath });
    return null;
  }
  const baseDir = path.dirname(filePath);
  return {
    name: typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : path.basename(baseDir),
    description,
    filePath,
    baseDir,
    disableModelInvocation: readDisableModelInvocation(frontmatter),
    sourceInfo: { source: source.source, scope: source.scope },
  };
}

async function realKey(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return filePath;
  }
}

/** Discover the skills a pi session in cwd loads. The first skill of a name wins, as in pi; the result is sorted by
 * name. `piBin` (for `pi list`) is a test seam; null lists no package skills. `scope` "user" reads the user sources
 * only. */
export async function discoverSkills(
  cwd: string,
  piBin: string | null = resolvePiBin(),
  scope?: "user",
): Promise<SkillsWithDiagnostics> {
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, SkillInfo>();
  const seen = new Set<string>();
  for (const source of await skillSources(cwd, piBin, diagnostics, scope)) {
    for (const entry of source.paths) {
      let files: string[];
      try {
        files = (await fs.stat(entry)).isDirectory() ? await collectSkillEntries(entry, source.mode) : [entry];
      } catch {
        continue; // pi skips a missing path (and warns for a missing settings entry).
      }
      for (const file of files) {
        const skill = await loadSkillFile(file, source, diagnostics);
        if (!skill) continue;
        const key = await realKey(file);
        if (seen.has(key)) continue;
        if (byName.has(skill.name)) {
          diagnostics.push({ type: "warning", message: `name "${skill.name}" collision`, path: file });
          continue;
        }
        byName.set(skill.name, skill);
        seen.add(key);
      }
    }
  }
  const skills = [...byName.values()].sort((a, b) => {
    const cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return cmp !== 0 ? cmp : a.filePath.localeCompare(b.filePath);
  });
  return { skills, diagnostics };
}

/**
 * Roots a SKILL.md must sit under for PATCH /api/skills to rewrite it: the
 * allowed file roots (workspaces the user opened, so their files are the
 * user's) plus the auto-discovered skill directories (with the project ones
 * when cwd is itself allowed). Skills from anywhere else (packages, settings
 * paths outside a workspace) are read-only: their files belong to an installer
 * and an update would discard the edit.
 */
export async function getSkillToggleRoots(cwd?: string): Promise<Set<string>> {
  // Copy: getAllowedFileRoots returns its shared cache set.
  const roots = new Set(await getAllowedFileRoots());
  const scanCwd = cwd && isExistingFilePathAllowed(cwd, roots) ? cwd : undefined;
  for (const dir of getSkillScanRootDirs(scanCwd)) roots.add(dir);
  return roots;
}

export async function loadSkillsWithInstallInfo(cwd: string, piBin: string | null = resolvePiBin(), scope?: "user") {
  const [{ skills, diagnostics }, toggleRoots] = await Promise.all([discoverSkills(cwd, piBin, scope), getSkillToggleRoots(cwd)]);
  const isTogglable = existingPathWithinRootsChecker(toggleRoots);
  return {
    skills: annotateSkillsWithInstallInfo(skills, { cwd, agentDir: getAgentDir() }).map((skill) => ({
      ...skill,
      togglable: isTogglable(skill.filePath),
    })),
    diagnostics,
  };
}

/** The user level only, for a request without a cwd (a cluster member's settings act on this machine's, spec K7): `pi list`
 * runs in its agent directory, where no project lies, and a project-scope entry is left out all the same. */
export async function loadUserSkillsWithInstallInfo(piBin: string | null = resolvePiBin()) {
  const listed = await loadSkillsWithInstallInfo(ensureAgentDir(), piBin, "user");
  return { ...listed, skills: listed.skills.filter((skill) => skill.sourceInfo?.scope !== "project") };
}
