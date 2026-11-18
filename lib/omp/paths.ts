import { existsSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import * as path from "path";

/**
 * Directory resolution mirroring @earendil-works/pi-coding-agent (config.ts & session-manager.ts).
 * Covered: PI_CODING_AGENT_DIR override and PI_CONFIG_DIR rename.
 */

const CONFIG_DIR_NAME = ".pi";

export function getConfigDirName(): string {
  return process.env.PI_CONFIG_DIR || CONFIG_DIR_NAME;
}

/** Config root: ~/.pi (plus PI_CONFIG_DIR rename). */
export function getConfigRoot(): string {
  return path.join(homedir(), getConfigDirName());
}

/** The agent state directory (~/.pi/agent). PI_CODING_AGENT_DIR overrides it. */
export function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) return path.resolve(override);
  return path.join(getConfigRoot(), "agent");
}

/** The agent directory, created owner-only when missing. */
export function ensureAgentDir(): string {
  const dir = getAgentDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function isDefaultAgentDir(): boolean {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) {
    return path.resolve(override) === path.join(getConfigRoot(), "agent");
  }
  return true;
}

/** tau's crash/stall journal directory: ~/.pi/omp-web, or
 * <agent dir>/omp-web when PI_CODING_AGENT_DIR points elsewhere, so isolated
 * runs (tests, dev servers) never write the real journal. */
export function getDiagnosticsDir(): string {
  return path.join(isDefaultAgentDir() ? getConfigRoot() : getAgentDir(), "omp-web");
}

/** ~/.pi/agent/sessions */
export function getSessionsDir(): string {
  return path.join(getAgentDir(), "sessions");
}

/** Archive root for compressed session JSONL files. */
export function getArchivedSessionsDir(): string {
  return path.join(path.dirname(getSessionsDir()), "archive", "sessions");
}

/** Content-addressed blob store referenced from session entries. */
export function getBlobsDir(): string {
  return path.join(getAgentDir(), "blobs");
}

/** Settings file (JSON): ~/.pi/agent/settings.json. */
export function getSettingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

/** Custom models file (JSON): ~/.pi/agent/models.json. */
export function getModelsConfigPath(): string {
  return path.join(getAgentDir(), "models.json");
}

/** Best-effort canonicalization: resolve symlinks when the path exists,
 * otherwise keep the resolved input. */
function canonicalize(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

/**
 * Session directory slug for a cwd — matches pi's getDefaultSessionDirPath
 * in core/session-manager.ts:
 * `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 */
export function getSessionDirNameForCwd(cwd: string): string {
  const resolvedCwd = canonicalize(path.resolve(cwd));
  return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** User-level agents directory (~/.pi/agent/agents). */
export function getUserAgentsDir(): string {
  return path.join(getAgentDir(), "agents");
}

/** Project-level agents directory (./.pi/agents at git root, or cwd fallback). */
export function getProjectAgentsDir(cwd: string): string {
  let current = path.resolve(cwd);
  const home = homedir();
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Keep walking until the nearest project boundary.
    }
    if (existsSync(path.join(current, ".git"))) return candidate;
    if (current === home) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(path.resolve(cwd), ".pi", "agents");
}

/** Cache directory for unpacked bundled agents (temp). */
export function getAgentsBundledCacheDir(): string {
  return path.join(tmpdir(), "tau-bundled-agents");
}

const WINDOWS_LOCAL_ROOT_MAX_CHARS = 180;

/** `local://` root for a session. */
export function sessionLocalRoot(sessionFile: string, sessionId: string, platform: NodeJS.Platform = process.platform): string {
  const candidate = path.resolve(path.dirname(sessionFile), path.basename(sessionFile, ".jsonl"), "local");
  if (platform === "win32" && candidate.length >= WINDOWS_LOCAL_ROOT_MAX_CHARS) {
    return path.join(tmpdir(), "omp-local", sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  }
  return candidate;
}
