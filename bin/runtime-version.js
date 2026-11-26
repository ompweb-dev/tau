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

module.exports = { MIN_BUN_VERSION, exitIfUnsupportedRuntime, getUnsupportedRuntimeMessage, isBunVersionSupported };
