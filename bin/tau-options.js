"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hashPassword, isPasswordHash } = require("./tau-password-hash");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isLoopbackHost } = require("./network-addresses");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

/** Legacy plaintext credential: detected so `tau` can migrate (env) or refuse (flag) it. */
function legacyPassword(args, env) {
  const flagIndex = args.findIndex((arg) => arg === "--password" || arg.startsWith("--password="));
  if (flagIndex !== -1) {
    const arg = args[flagIndex];
    const inline = arg.startsWith("--password=") ? arg.slice("--password=".length) : undefined;
    const value = inline !== undefined ? inline : (args[flagIndex + 1] ?? "");
    return { value, source: "flag" };
  }
  const fromEnv = env.TAU_PASSWORD;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return { value: fromEnv, source: "env" };
  return undefined;
}

function printHelp() {
  console.log(`Usage: tau [options]

Options:
  -p, --port <port>        Server port (default 30187, env PORT)
  -H, --hostname <host>    Bind hostname (default 127.0.0.1, env TAU_HOSTNAME)
      --no-open            Do not open the browser automatically
      --install-tray       Install system tray service & shortcuts (Windows tray / Linux SNI tray)
      --uninstall-tray     Uninstall system tray service & shortcuts
      --tray               Start background system tray manager
  -h, --help               Show this help
      --version            Show version

Commands:
  hash-password            Read a password from stdin and print the value for
                           TAU_PASSWORD_HASH

Password:
  tau hash-password                       # prompts, input hidden
  echo "a-long-random-password" | tau hash-password
  TAU_PASSWORD_HASH='scrypt$15$8$1$...' tau

  tau never passes a plaintext password on: --password is rejected, and an
  TAU_PASSWORD is hashed at startup with a warning that prints its hash
  (set alongside TAU_PASSWORD_HASH, it is rejected), because every omp
  session inherits the environment and an agent could print the password
  into its transcript.

Security: use HTTPS via a trusted reverse proxy or VPN when binding to a
non-loopback hostname, so the password and session cookie stay private.`);
}

/**
 * Resolve launch options from argv and the environment. A legacy plaintext
 * password (env or `--password`) is reported instead of parsed: the caller
 * migrates or refuses it rather than passing it to the server. A bad port is
 * reported in `error`, which the caller prints before exiting with 2.
 * @returns {{ port: string, hostname: string, passwordHash?: string, legacyPassword?: string, legacyPasswordSource?: "env" | "flag", openBrowser: boolean, installTray: boolean, uninstallTray: boolean, tray: boolean, help?: boolean, version?: boolean, error?: string }}
 */
function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      help:      { type: "boolean", short: "h" },
      version:   { type: "boolean" },
      "no-open":         { type: "boolean" },
      "install-tray":    { type: "boolean" },
      "install-service": { type: "boolean" },
      "uninstall-tray":  { type: "boolean" },
      tray:              { type: "boolean" },
    },
    strict: false,
  });

  const passwordHash = typeof env.TAU_PASSWORD_HASH === "string" ? env.TAU_PASSWORD_HASH.trim() : undefined;
  const legacy = legacyPassword(args, env);

  const port = String(cliArgs.port ?? env.PORT ?? "30187");
  const shared = {
    port,
    hostname: cliArgs.hostname ?? env.TAU_HOSTNAME ?? "127.0.0.1",
    passwordHash,
    legacyPassword: legacy?.value,
    legacyPasswordSource: legacy?.source,
    openBrowser: !cliArgs["no-open"] && !isEnabled(env.TAU_NO_OPEN),
    installTray: Boolean(cliArgs["install-tray"] || cliArgs["install-service"]),
    uninstallTray: Boolean(cliArgs["uninstall-tray"]),
    tray: Boolean(cliArgs.tray),
    ...(/^\d{1,5}$/.test(port) && Number(port) <= 65535 ? {} : { error: `Invalid port: ${port}. Use an integer from 0 to 65535.` }),
  };

  if (cliArgs.version) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require("../package.json");
      console.log(pkg.version ?? "0.0.0");
    } catch { console.log("0.0.0"); }
    return { ...shared, version: true };
  }
  // Expose help flag without exiting here — caller (bin/tau.js) decides
  // whether to exit, keeping parseLaunchOptions testable. Print here so
  // --help works even when the caller is a test.
  if (cliArgs.help) {
    printHelp();
    return { ...shared, help: true };
  }
  return shared;
}

/**
 * The password and bind checks before a server starts (bin/tau.js, server/binary.ts). Only a password hash reaches
 * the server (issue #239): a plaintext TAU_PASSWORD alone is migrated, hashed into TAU_PASSWORD_HASH and
 * removed from process.env before any child can inherit it. The removed --password flag, a plaintext set next to a
 * hash, an invalid hash, or a non-loopback bind without a password print why and exit 1.
 * @returns {string | undefined} the password hash, if any
 */
function checkLaunchSecurity(launchOptions) {
  let passwordHash = launchOptions.passwordHash;
  if (launchOptions.legacyPasswordSource === "env" && !passwordHash) {
    passwordHash = hashPassword(process.env.TAU_PASSWORD);
    process.env.TAU_PASSWORD_HASH = passwordHash;
    delete process.env.TAU_PASSWORD;
    console.warn([
      "Warning: TAU_PASSWORD holds a plaintext password. This option has been deprecated and is marked for removal.",
      "",
      "Every omp session inherits tau's environment, so an agent could print",
      "the password into its transcript. tau hashed it and kept it out of the",
      "server's environment, but agents can still read it from this launcher",
      "process, and a new hash is made on every start, which signs every browser",
      "out on each restart.",
      "",
      "Remove TAU_PASSWORD and set this instead:",
      "",
      `  TAU_PASSWORD_HASH='${passwordHash}'`,
    ].join("\n"));
  } else if (launchOptions.legacyPasswordSource === "env") {
    console.error("TAU_PASSWORD_HASH and the plaintext TAU_PASSWORD are both set. Remove TAU_PASSWORD.");
    process.exit(1);
  } else if (launchOptions.legacyPassword !== undefined) {
    console.error([
      "tau no longer accepts a plaintext password: the --password flag was removed.",
      "Every omp session inherits this process's environment, so an agent could",
      "print the password into its transcript.",
      "",
      "Create a hash and use that instead:",
      "",
      "  tau hash-password",
      "  TAU_PASSWORD_HASH='scrypt$...' tau",
    ].join("\n"));
    process.exit(1);
  }
  if (passwordHash !== undefined && !isPasswordHash(passwordHash)) {
    console.error(`TAU_PASSWORD_HASH is not a valid password hash.\n\nGenerate one with: tau hash-password`);
    process.exit(1);
  }
  const { hostname } = launchOptions;
  if (!isLoopbackHost(hostname)) {
    if (passwordHash === undefined) {
      console.error(`Refusing to listen on ${hostname} without a password hash. Run: tau hash-password, then set TAU_PASSWORD_HASH. Or bind to 127.0.0.1.`);
      process.exit(1);
    }
    console.warn(`Warning: tau is listening on ${hostname} over HTTP. Use HTTPS or a trusted VPN to protect the password and session cookie in transit.`);
  }
  return passwordHash;
}

// The server must not start inside the installation: on Windows a live process whose working
// directory is the package blocks the rename an in-place update performs
// (ERROR_SHARING_VIOLATION). The entry point and TAU_PACKAGE_DIR are absolute, so the
// server does not need the installation as its directory.
function serverWorkingDirectory(home = os.homedir()) {
  if (!home) throw new Error("Cannot start tau: the home directory is empty, and the server must not run inside its installation.");
  return home;
}

module.exports = { checkLaunchSecurity, parseLaunchOptions, printHelp, serverWorkingDirectory };
