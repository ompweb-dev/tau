import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { MIN_BUN_VERSION, getUnsupportedRuntimeMessage, isBunVersionSupported } = require("./runtime-version.js");

test("accepts the minimum Bun and newer, rejects older and invalid versions", () => {
  for (const version of ["1.4.4", "1.4.5", "1.10.0", "2.0.0"]) assert.equal(isBunVersionSupported(version), true, version);
  for (const version of ["1.4.3", "1.3.9", "0.9.9", "invalid", undefined]) assert.equal(isBunVersionSupported(version), false, String(version));
});

test("keeps the package engine aligned with the startup check", () => {
  assert.equal(packageJson.engines.bun, `>=${MIN_BUN_VERSION}`);
  assert.equal(packageJson.engines.node, undefined);
});

test("names Bun as the runtime to install, or the version to upgrade from", () => {
  assert.match(getUnsupportedRuntimeMessage({ node: "24.0.0" }), /runs on Bun 1\.4\.4 or newer, not Node\.js[\s\S]*bun add -g @ompweb-dev\/tau/);
  assert.match(getUnsupportedRuntimeMessage({ bun: "1.3.0" }), /requires Bun 1\.4\.4 or newer; this is Bun 1\.3\.0/);
});

const node = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;
for (const [name, script] of Object.entries(packageJson.bin)) {
  test(`${name} runs on Bun and refuses Node.js before doing anything`, { skip: !node && "no node on PATH" }, () => {
    assert.match(readFileSync(join(root, script), "utf8"), /^#!\/usr\/bin\/env bun\n/);
    const result = spawnSync("node", [join(root, script), "--help"], { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /runs on Bun 1\.4\.4 or newer, not Node\.js/);
  });
}
