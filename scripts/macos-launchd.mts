#!/usr/bin/env bun
// Install tau as a macOS launchd user agent (starts at login, restarts on crash).
//
// Usage (installed as the `tau-launchd` bin, or run via npx / bun directly):
//   tau-launchd [install [package-spec]|uninstall|status]
//   npx -p @ompweb-dev/tau@latest tau-launchd install
//
// The positional package-spec picks what the service runs via `npx --yes`
// (default @ompweb-dev/tau@latest; env TAU_PKG is an equivalent override).
//
// Configuration (read at install time, baked into the plist):
//   TAU_PKG          npm package spec run via npx               default @ompweb-dev/tau@latest
//   PORT                 Server port                                default 30187
//   TAU_HOSTNAME     Server bind host                           default 127.0.0.1
//   TAU_PASSWORD     Optional plaintext password, hashed before it is written
//   TAU_PASSWORD_HASH  Password hash from `tau hash-password` (preferred)
//   TAU_NO_OPEN      Set to 0 to auto-open the browser          default 1 (no auto-open)
//   TAU_PI_BIN       The pi binary                             default pi on PATH
//   PI_CODING_AGENT_DIR  Custom pi agent directory                  default ~/.pi/agent
//
// Example (loopback-only; require auth + trusted HTTPS proxy/VPN for remote access):
//   TAU_PASSWORD=secret tau-launchd install

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error - plain CJS helper, no type declarations
import { resolvePasswordHash } from "../bin/tau-hash-password.js";

const LABEL = "dev.ompweb.tau";
const HOME = os.homedir();
const PLIST = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(HOME, "Library", "Logs", "tau");
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;

// Print an error and exit non-zero.
function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

// True when the path is an executable regular file.
function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// Locate an executable on the caller's PATH.
function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && isExecutableFile(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

// Escape a value for embedding in plist XML.
function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Run launchctl; by default a failure is fatal.
function launchctl(args: string[], { ignoreFailure = false } = {}): string {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.error) fail(`launchctl not runnable: ${result.error.message}`);
  if (result.status !== 0 && !ignoreFailure) {
    fail(`launchctl ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

function install(pkgArg?: string): void {
  // Resolve absolute paths now: launchd agents run with a minimal PATH
  // (/usr/bin:/bin:/usr/sbin:/sbin), so nothing from nvm/asdf/homebrew is visible.
  // Prefer the npx sitting next to the real bun binary over the PATH hit:
  // version-manager shims (asdf/nvm) re-invoke their manager by name and can
  // fail under launchd's minimal environment.
  const runtimeBin = process.execPath;
  const siblingNpx = path.join(path.dirname(runtimeBin), "npx");
  const npxBin = isExecutableFile(siblingNpx) ? siblingNpx : (which("npx") ?? fail("npx not found on PATH"));

  // An explicit pi for the service; without it the service finds pi on PATH.
  const piBin = process.env.TAU_PI_BIN || null;
  if (piBin) {
    try {
      fs.accessSync(piBin, fs.constants.X_OK);
    } catch {
      fail(`TAU_PI_BIN=${piBin} is not executable`);
    }
  }

  // Service parameters with defaults; the positional package spec wins over env.
  const pkg = pkgArg ?? process.env.TAU_PKG ?? "@ompweb-dev/tau@latest";
  const port = process.env.PORT ?? "30187";
  const hostname = process.env.TAU_HOSTNAME ?? "127.0.0.1";
  const noOpen = process.env.TAU_NO_OPEN ?? "1";
  // Only a hash reaches the plist: tau no longer reads a plaintext
  // password, so hash one if it was given here (issue #239).
  const passwordHash = resolvePasswordHash();
  // launchd does not expand `~` in environment values — resolve it now.
  const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, HOME);

  // Give the service a PATH covering npx/bun, omp, and system tools (`open`
  // for the browser). asdf/nvm shims re-invoke their manager by name, so the
  // manager's own directory must be reachable too when present.
  const asdfBin = which("asdf");
  const svcPath = [
    ...(piBin ? [path.dirname(piBin)] : []),
    ...(asdfBin ? [path.dirname(asdfBin)] : []),
    path.dirname(npxBin),
    path.dirname(runtimeBin),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((dir, i, all) => all.indexOf(dir) === i).join(path.delimiter);

  // Environment baked into the service; optional entries only when set.
  const env: Record<string, string> = {
    PATH: svcPath,
    PORT: port,
    TAU_HOSTNAME: hostname,
    TAU_NO_OPEN: noOpen,
    ...(passwordHash ? { TAU_PASSWORD_HASH: passwordHash } : {}),
    ...(piBin ? { TAU_PI_BIN: piBin } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
  const envXml = Object.entries(env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(npxBin)}</string>
    <string>--yes</string>
    <string>${xmlEscape(pkg)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key><string>${xmlEscape(HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(LOG_DIR, "tau.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(LOG_DIR, "tau.err.log"))}</string>
</dict>
</plist>
`;

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  // Password lives in the plist as plain text; keep it user-readable only.
  fs.writeFileSync(PLIST, plist, { mode: 0o600 });
  fs.chmodSync(PLIST, 0o600);

  // Reload: bootout fails harmlessly when the agent isn't currently loaded.
  launchctl(["bootout", `${DOMAIN}/${LABEL}`], { ignoreFailure: true });
  launchctl(["bootstrap", DOMAIN, PLIST]);

  console.log(`installed: ${PLIST}`);
  console.log(`package:   ${pkg} (via npx --yes)`);
  console.log(`url:       http://${hostname}:${port}`);
  console.log(`logs:      ${path.join(LOG_DIR, "tau.log")}`);
  if (password) console.log("note:      password is stored in plain text in the plist (mode 600)");
}

function uninstall(): void {
  launchctl(["bootout", `${DOMAIN}/${LABEL}`], { ignoreFailure: true });
  fs.rmSync(PLIST, { force: true });
  console.log(`uninstalled: ${LABEL}`);
}

function status(): void {
  const result = spawnSync("launchctl", ["print", `${DOMAIN}/${LABEL}`], { encoding: "utf8" });
  if (result.status === 0) {
    const lines = (result.stdout ?? "").split("\n").filter((line) => /\b(state|pid|last exit)\b/.test(line));
    console.log(lines.join("\n") || (result.stdout ?? "").trim());
    return;
  }
  console.log(`not loaded: ${LABEL}`);
  process.exit(1);
}

if (process.platform !== "darwin") fail("launchd services are macOS-only");

const command = process.argv[2] ?? "install";
if (command === "install") install(process.argv[3]);
else if (command === "uninstall") uninstall();
else if (command === "status") status();
else {
  console.error("usage: tau-launchd [install [package-spec]|uninstall|status]");
  process.exit(2);
}
