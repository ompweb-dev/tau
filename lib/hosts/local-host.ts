import { existsSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { comparableProjectPath } from "../comparable-path";
import { getAgentEnvOverrides } from "../pi/agent-env";
import { spawnPiTransport } from "../pi/rpc-process";
import { isReservedLaunchArg, loadProjectRegistry } from "../project-registry";
import { invalidateSessionEntriesCache, invalidateSessionListCache, invalidateSessionListMeta } from "../session-reader";
import { PRESET_FULL } from "../tool-presets";
import type { ProjectLaunchConfig } from "../types";
import { registeredProjectFor, resolveProject } from "../worktree";
import { HostOpError } from "./link-protocol";
import type { Host } from "./host";
import { sessionOps } from "./session-ops";

/** Translate preset tool names into pi builtin tool names. */
export function mapPresetToolNames(toolNames: string[]): string[] {
  const out: string[] = [];
  for (const raw of toolNames) {
    const lower = raw.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

const FULL_PRESET_KEY = [...PRESET_FULL].map((n) => n.toLowerCase()).sort().join(",");

/** Extra CLI args for spawning `pi --mode rpc` for a session. */
export function buildSessionSpawnArgs(sessionFile: string, toolNames?: string[], launchConfig?: ProjectLaunchConfig): string[] {
  const args: string[] = [];
  if (sessionFile) {
    args.push("--session", sessionFile);
  } else if (toolNames !== undefined) {
    const presetKey = toolNames.map((n) => n.toLowerCase()).sort().join(",");
    if (toolNames.length === 0) {
      args.push("--no-tools");
    } else if (presetKey === FULL_PRESET_KEY) {
      // "Full" means everything: leave pi's complete default toolset intact.
    } else {
      const mapped = mapPresetToolNames(toolNames);
      if (mapped.length > 0) args.push("--tools", mapped.join(","));
    }
  }
  if (launchConfig?.extraArgs) {
    const reserved = launchConfig.extraArgs.find(isReservedLaunchArg);
    if (reserved !== undefined) {
      throw new HostOpError(400, "stored_reserved_launch_arg", `Saved workspace extra arguments contain the reserved option ${JSON.stringify(reserved)}. Open the workspace launch configuration and remove it and its value before starting a session.`);
    }
    args.push(...launchConfig.extraArgs);
  }
  return args;
}

/**
 * Pick a spawn cwd that actually exists. A session records the directory it was
 * created in, but that directory may have been deleted since: spawn() would
 * fail with ENOENT, so hand pi a live directory instead.
 */
export function resolveSpawnCwd(recordedCwd?: string | null): string {
  return resolveSpawnCwdResult(recordedCwd).cwd;
}

/**
 * Resolve a spawn cwd and report whether it differs from the session's recorded
 * directory. Callers that surface a UI (the SSE resume paths) use the result to
 * emit a notice so the user knows the agent is running somewhere other than the
 * directory the sidebar/header still advertises — a silent wrong-tree fallback
 * would let file tool calls edit an unexpected repo with no signal.
 */
export function resolveSpawnCwdResult(recordedCwd?: string | null): { cwd: string; fellBack: boolean } {
  // A file at the path exists but cannot be a cwd: spawn() would fail with ENOTDIR.
  const isDirectory = (path: string) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  if (recordedCwd && isDirectory(recordedCwd)) return { cwd: recordedCwd, fellBack: false };
  try {
    const serverCwd = process.cwd();
    if (serverCwd && isDirectory(serverCwd)) return { cwd: serverCwd, fellBack: true };
  } catch {
    // process.cwd() itself throws when the server's own cwd was removed.
  }
  return { cwd: homedir(), fellBack: true };
}

/** Look up the workspace-registered launch config; unregistered projects attach none. */
export async function launchConfigForCwd(cwd: string): Promise<ProjectLaunchConfig | undefined> {
  let canonical = cwd;
  try { canonical = realpathSync(cwd); } catch {}
  const projects = loadProjectRegistry().projects.filter((project) => !project.hidden);
  const key = comparableProjectPath(canonical);
  const direct = projects.find((project) => comparableProjectPath(project.path) === key);
  if (direct) return direct.launchConfig;
  const { projectRoot } = await resolveProject(canonical);
  const rootKey = comparableProjectPath(projectRoot);
  return projects.find((project) => {
    const projectKey = comparableProjectPath(project.path);
    return projectKey === rootKey || key.startsWith(`${projectKey}-worktrees/`);
  })?.launchConfig;
}

/** pi's `--approve` (trust the project's .pi and .agents files) for a cwd inside a workspace registered on this
 * machine; elsewhere pi's own trust rules apply (trust.json, then defaultProjectTrust, with no prompt in rpc mode). */
export async function projectTrustArgs(cwd: string): Promise<string[]> {
  return await registeredProjectFor(cwd) ? ["--approve"] : [];
}

/** This machine: `child_process.spawn` and direct `fs`. */
export const localHost: Omit<Host, "workspaceOps"> = {
  id: "local",
  label: "This machine",
  sessionOps,
  status: () => "online",
  onStatus: () => () => {},
  async spawnRpc(request) {
    const { cwd } = request;
    const launchConfig = await launchConfigForCwd(cwd);
    if (request.creationId !== undefined) {
      try {
        if (!statSync(cwd).isDirectory() || comparableProjectPath(realpathSync(cwd)) !== comparableProjectPath(cwd)) throw new Error("Prepared cwd changed");
      } catch {
        throw new HostOpError(409, "prepared_cwd_changed", "The prepared worktree is no longer available");
      }
    }
    const transport = spawnPiTransport({
      cwd,
      // Re-read per spawn so a respawn picks up environment values the user
      // added in Settings after the session was created (#104).
      env: getAgentEnvOverrides(),
      extraArgs: [...await projectTrustArgs(cwd), ...buildSessionSpawnArgs(request.sessionFile, request.toolNames, launchConfig)],
    });
    return {
      transport,
      cwd,
      fellBack: !!request.recordedCwd && request.recordedCwd !== cwd,
    };
  },
  async sessionFileExists(path) {
    return existsSync(path);
  },
  /** Invalidate session-list metadata plus ONLY this session's parse caches
   * when the file path is known, else fall back to the full invalidation. */
  invalidateSessionLists(sessionFile) {
    if (sessionFile) {
      invalidateSessionListMeta();
      invalidateSessionEntriesCache(sessionFile);
    } else {
      invalidateSessionListCache();
    }
  },
};
