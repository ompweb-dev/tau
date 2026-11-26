"use strict";

// Every published executable runs on Bun (the `#!/usr/bin/env bun` line); npm treats `engines` as advisory, so each checks first.
const MIN_BUN_VERSION = "1.4.4";

function isBunVersionSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const minimum = MIN_BUN_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index] > minimum[index];
  }
  return true;
}

function getUnsupportedRuntimeMessage(versions) {
  if (!versions.bun) {
    return [
      `tau runs on Bun ${MIN_BUN_VERSION} or newer, not Node.js.`,
      "Install Bun (https://bun.sh), then run tau with it: bun add -g @ompweb-dev/tau",
    ].join("\n");
  }
  return [`tau requires Bun ${MIN_BUN_VERSION} or newer; this is Bun ${versions.bun}.`, "Upgrade Bun and try again: bun upgrade"].join("\n");
}

/** First statement of every published executable. */
function exitIfUnsupportedRuntime() {
  if (isBunVersionSupported(process.versions.bun)) return;
  console.error(getUnsupportedRuntimeMessage(process.versions));
  process.exit(1);
}

/**
 * The directory a service's PATH needs for the bins' `#!/usr/bin/env bun`: this Bun's, else (npm's bun package names its
 * binary bun.exe) that of the bun on `PATH`. Throws when there is no file named bun in either.
 */
function bunDirectory(execPath = process.execPath, env = process.env) {
  const { accessSync, constants, statSync } = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const isBun = (dir) => {
    try {
      const file = path.join(dir, process.platform === "win32" ? "bun.exe" : "bun");
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const candidates = [path.dirname(execPath), ...(env.PATH ?? "").split(path.delimiter).filter(Boolean)];
  const found = candidates.find(isBun);
  if (!found) throw new Error("no executable named bun next to this Bun or on PATH: install Bun (https://bun.sh)");
  return found;
}

module.exports = { MIN_BUN_VERSION, bunDirectory, exitIfUnsupportedRuntime, getUnsupportedRuntimeMessage, isBunVersionSupported };
