#!/usr/bin/env bun
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { bunDirectory, exitIfUnsupportedRuntime } = require("./runtime-version");
exitIfUnsupportedRuntime();

// Install tau as a macOS launchd user agent (starts at login, restarts on crash).
//
// Usage (installed as the `tau-launchd` bin, or run via npx / node directly):
//   tau-launchd [install [package-spec]|uninstall|status]
//   npx -p @ompweb-dev/tau@latest tau-launchd install

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolvePasswordHash } = require("./tau-hash-password");

const LABEL = "dev.ompweb.tau";
// The host daemon links this machine to an tau (`tau host`); it runs next to the web agent.
const HOST_LABEL = "dev.ompweb.tau-host";
const HOME = os.homedir();
const PLIST = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const HOST_PLIST = path.join(HOME, "Library", "LaunchAgents", `${HOST_LABEL}.plist`);
const LOG_DIR = path.join(HOME, "Library", "Logs", "tau");
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function which(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && isExecutableFile(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function xmlEscape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function launchctl(args, { ignoreFailure = false } = {}) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.error) fail(`launchctl not runnable: ${result.error.message}`);
  if (result.status !== 0 && !ignoreFailure) {
    fail(`launchctl ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

// One launch agent; `throttleInterval` (seconds) spaces out KeepAlive restarts.
function buildPlist({ label, args, env, logName, throttleInterval }) {
  const argsXml = args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  const envXml = Object.entries(env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key><string>${xmlEscape(HOME)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>${throttleInterval ? `\n  <key>ThrottleInterval</key><integer>${throttleInterval}</integer>` : ""}
  <key>StandardOutPath</key><string>${xmlEscape(path.join(LOG_DIR, `${logName}.log`))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(LOG_DIR, `${logName}.err.log`))}</string>
</dict>
</plist>
`;
}

// The daemon needs the web agent's PATH, pi binary and agent dir (host.json), not its password.
function buildHostEnv({ svcPath, piBin, agentDir }) {
  return {
    PATH: svcPath,
    ...(piBin ? { TAU_PI_BIN: piBin } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
}

function install(pkgArg) {
  const runtimeBin = process.execPath;
  // npx, not bunx: an in-app update recognizes npm's cache as an npm install, never bunx's.
  const siblingNpx = path.join(path.dirname(runtimeBin), "npx");
  const npxBin = isExecutableFile(siblingNpx) ? siblingNpx : (which("npx") ?? fail("npx not found on PATH: the launchd agents run tau through npm's npx, so install npm (Node.js)"));
  // npm's npx is `#!/usr/bin/env node`: the agents need node's directory too.
  const siblingNode = path.join(path.dirname(npxBin), "node");
  const nodeBin = isExecutableFile(siblingNode) ? siblingNode : (which("node") ?? fail("node not found on PATH: npm's npx, which the launchd agents run, needs it"));
  let bunDir;
  try {
    bunDir = bunDirectory();
  } catch (error) {
    fail(error.message);
  }

  // An explicit pi for the service; without it the service finds pi on PATH.
  const piBin = process.env.TAU_PI_BIN || null;
  if (piBin) {
    try {
      fs.accessSync(piBin, fs.constants.X_OK);
    } catch {
      fail(`TAU_PI_BIN=${piBin} is not executable`);
    }
  }

  const pkg = pkgArg ?? process.env.TAU_PKG ?? "@ompweb-dev/tau@latest";
  const port = process.env.PORT ?? "30187";
  const hostname = process.env.TAU_HOSTNAME ?? "127.0.0.1";
  const noOpen = process.env.TAU_NO_OPEN ?? "1";
  const disableAutoUpdate = process.env.TAU_DISABLE_AUTOUPDATE;
  const installName = process.env.TAU_NAME;
  // Only a hash is stored in the plist: tau never forwards a plaintext
  // password, and `TAU_PASSWORD` set for this install is hashed here.
  let passwordHash;
  try {
    passwordHash = resolvePasswordHash();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const trustedHeaderDigest = process.env.TAU_TRUSTED_HEADER_SHA256;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, HOME);

  const asdfBin = which("asdf");
  const svcPath = [
    ...(piBin ? [path.dirname(piBin)] : []),
    ...(asdfBin ? [path.dirname(asdfBin)] : []),
    bunDir,
    path.dirname(npxBin),
    path.dirname(nodeBin),
    path.dirname(runtimeBin),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((dir, i, all) => all.indexOf(dir) === i).join(path.delimiter);

  const env = {
    PATH: svcPath,
    PORT: port,
    TAU_HOSTNAME: hostname,
    TAU_NO_OPEN: noOpen,
    ...(disableAutoUpdate ? { TAU_DISABLE_AUTOUPDATE: disableAutoUpdate } : {}),
    ...(installName ? { TAU_NAME: installName } : {}),
    ...(passwordHash ? { TAU_PASSWORD_HASH: passwordHash } : {}),
    ...(trustedHeaderDigest ? { TAU_TRUSTED_HEADER_SHA256: trustedHeaderDigest } : {}),
    ...(piBin ? { TAU_PI_BIN: piBin } : {}),
    ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
  };
  const web = buildPlist({ label: LABEL, args: [npxBin, "--yes", pkg], env, logName: "tau" });
  const host = buildPlist({
    label: HOST_LABEL,
    args: [npxBin, "--yes", pkg, "host"],
    env: buildHostEnv({ svcPath, piBin, agentDir }),
    logName: "tau-host",
    // host.json does not exist until the web server first starts; the daemon exits until then.
    throttleInterval: 10,
  });

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  for (const [file, xml, label] of [[PLIST, web, LABEL], [HOST_PLIST, host, HOST_LABEL]]) {
    // Reloading the daemon ends every pi run on this machine: leave it alone when nothing changed.
    const unchanged = label === HOST_LABEL && fs.existsSync(file) && fs.readFileSync(file, "utf8") === xml;
    if (unchanged && spawnSync("launchctl", ["print", `${DOMAIN}/${label}`], { stdio: "ignore" }).status === 0) continue;
    fs.writeFileSync(file, xml, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    launchctl(["bootout", `${DOMAIN}/${label}`], { ignoreFailure: true });
    launchctl(["bootstrap", DOMAIN, file]);
  }

  console.log(`installed: ${PLIST}`);
  console.log(`installed: ${HOST_PLIST}`);
  console.log(`package:   ${pkg} (via npx --yes)`);
  console.log(`url:       http://${hostname}:${port}`);
  console.log(`logs:      ${path.join(LOG_DIR, "tau.log")}, ${path.join(LOG_DIR, "tau-host.log")}`);
  if (passwordHash) console.log("note:      the password hash is stored in the plist (mode 600)");
}

function uninstall() {
  for (const [file, label] of [[PLIST, LABEL], [HOST_PLIST, HOST_LABEL]]) {
    launchctl(["bootout", `${DOMAIN}/${label}`], { ignoreFailure: true });
    fs.rmSync(file, { force: true });
    console.log(`uninstalled: ${label}`);
  }
}

function status() {
  let loaded = false;
  for (const label of [LABEL, HOST_LABEL]) {
    const result = spawnSync("launchctl", ["print", `${DOMAIN}/${label}`], { encoding: "utf8" });
    if (result.status === 0) {
      loaded ||= label === LABEL;
      const lines = (result.stdout ?? "").split("\n").filter((line) => /\b(state|pid|last exit)\b/.test(line));
      console.log(`${label}:\n${lines.join("\n") || (result.stdout ?? "").trim()}`);
    } else {
      console.log(`not loaded: ${label}`);
    }
  }
  // Exit status stays the web agent's: scripts that polled it before keep working.
  if (!loaded) process.exit(1);
}

function main() {
  if (process.platform !== "darwin") fail("launchd services are macOS-only");

  const command = process.argv[2] ?? "install";
  if (command === "install") install(process.argv[3]);
  else if (command === "uninstall") uninstall();
  else if (command === "status") status();
  else {
    console.error("usage: tau-launchd [install [package-spec]|uninstall|status]");
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { HOST_LABEL, LABEL, buildHostEnv, buildPlist };
