import { execFile } from "child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "fs";
import { delimiter, join } from "path";
import { createChildProcessEnvironment } from "../project-command-env";

/**
 * Locating and probing the `pi` coding agent binary (`@earendil-works/pi-coding-agent`).
 * Every live-agent capability goes through `pi --mode rpc`, so its absence is a
 * first-class, user-visible state.
 */

let cachedBin: string | null = null;
let binMissAt = 0;
let cachedVersion: { fingerprint: string; value: string; expiresAt: number } | null = null;
let versionMiss: { fingerprint: string | null; retryAt: number } | null = null;
let versionProbe: Promise<string | null> | null = null;

// .cmd/.bat launchers (e.g. npm-installed pi on Windows or a wrapper script) cannot
// be spawned directly by Node — spawning them requires a shell. Route them
// through `cmd.exe /c`; every other platform and binary passes through.
const WINDOWS_SCRIPT_RE = /\.cmd$|\.bat$/i;

/** Spawn target for `bin args`, routing Windows script launchers through cmd.exe. */
export function wrapWindowsScript(bin: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" && WINDOWS_SCRIPT_RE.test(bin)) {
    return { file: "cmd.exe", args: ["/c", bin, ...args] };
  }
  return { file: bin, args };
}

// Retry missing binaries and failed version probes after a short backoff so
// a later install or repair is picked up without a web server restart.
const MISS_TTL_MS = 30_000;
// Launchers can stay unchanged while their underlying package is updated.
const VERSION_TTL_MS = 5 * 60_000;

function isRunnableFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") {
      accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function findPiOnPath(): string | null {
  const pathEnv = process.env.PATH || "";
  const candidates = process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi.bat", "pi"] : ["pi"];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      const full = join(dir, name);
      if (isRunnableFile(full)) return full;
    }
  }
  return null;
}

function probePiBin(): string | null {
  const override = process.env.TAU_PI_BIN;
  if (override) return existsSync(override) ? override : null;
  return findPiOnPath();
}

/** What every caller that needs pi reports when resolvePiBin finds none. */
export const PI_NOT_FOUND = "pi binary not found. Install @earendil-works/pi-coding-agent or set TAU_PI_BIN.";

/** Resolve the `pi` binary: TAU_PI_BIN override, else `pi` on PATH.
 * Returns null when none exists. A hit is cached while the file exists; a miss is
 * re-probed after MISS_TTL_MS, or at once with `fresh`. */
export function resolvePiBin(fresh = false): string | null {
  if (fresh) {
    cachedBin = null;
    binMissAt = 0;
  }
  // A global npm/Bun update can replace or remove its launcher while this
  // server process is still alive. Never keep returning a stale cache entry.
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  cachedBin = null;
  if (Date.now() - binMissAt < MISS_TTL_MS) return null;
  const found = probePiBin();
  if (found) {
    cachedBin = found;
    binMissAt = 0;
    return found;
  }
  binMissAt = Date.now();
  return null;
}

/** Return the installed CLI version, using file metadata to invalidate cached
 * results without launching pi on every visit. An expiry covers opaque
 * launchers; concurrent callers share a probe. */
export function getPiVersion(fresh = false): Promise<string | null> {
  // fresh: a probe of its own, past the miss caches; one in flight may have looked before the binary arrived.
  if (fresh) { binMissAt = 0; versionMiss = null; return probePiVersion(); }
  versionProbe ??= probePiVersion().finally(() => {
    versionProbe = null;
  });
  return versionProbe;
}

/** Identity of the binary on disk; changes when it is replaced or updated. */
export function versionFingerprint(bin: string): string | null {
  try {
    const target = realpathSync(bin);
    const stat = statSync(target, { bigint: true });
    return [target, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch {
    return null;
  }
}

async function probePiVersion(): Promise<string | null> {
  const bin = resolvePiBin();
  const fingerprint = bin ? versionFingerprint(bin) : null;
  const now = Date.now();
  if (fingerprint && cachedVersion?.fingerprint === fingerprint && now < cachedVersion.expiresAt) {
    return cachedVersion.value;
  }
  if (versionMiss?.fingerprint === fingerprint && now < versionMiss.retryAt) return null;
  cachedVersion = null;
  if (!bin) {
    versionMiss = { fingerprint, retryAt: now + MISS_TTL_MS };
    return null;
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const target = wrapWindowsScript(bin, ["--version"]);
      // Without an explicit env this probe would inherit the server's full
      // environment, including tau's own secrets, into the child.
      execFile(target.file, target.args, { timeout: 30_000, windowsHide: true, env: createChildProcessEnvironment() }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const version = output.trim();
    if (version) {
      versionMiss = null;
      // Do not cache a probe across an executable replacement.
      if (fingerprint && versionFingerprint(bin) === fingerprint) {
        cachedVersion = { fingerprint, value: version, expiresAt: Date.now() + VERSION_TTL_MS };
      }
      return version;
    }
  } catch {
    // Fall through to the miss path: retry after the TTL.
  }
  versionMiss = { fingerprint, retryAt: Date.now() + MISS_TTL_MS };
  return null;
}
