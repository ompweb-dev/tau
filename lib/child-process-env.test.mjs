import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  createChildProcessEnvironment,
  TAU_SECRET_ENV_VARS,
} = await jiti.import("./project-command-env.ts");

test("strips the server-side STT key from child environments", () => {
  assert.ok(TAU_SECRET_ENV_VARS.includes("TAU_STT_KEY"));
  const env = createChildProcessEnvironment({}, {
    TAU_STT_KEY: "sk-stt-secret",
    TAU_PASSWORD_HASH: "scrypt$hash",
    KEEP_ME: "1",
  }, "linux");
  assert.equal(env.TAU_STT_KEY, undefined);
  assert.equal(env.TAU_PASSWORD_HASH, undefined);
  assert.equal(env.KEEP_ME, "1");
});

// The first-party omp spawns below used to pass no `env` option at all, so
// Node inherited the server's full environment — including the secrets the
// strip list exists to remove — into those children. Every execFile call
// site must route through the sanitizer.
for (const [file, marker] of [
  ["./skills-service.ts", "list"],
  ["./omp/omp-cli.ts", "--version"],
]) {
  test(`${file} sanitizes the environment of its omp spawn (${marker})`, () => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /createChildProcessEnvironment/);
    assert.match(source, /env: createChildProcessEnvironment\(/);
  });
}
