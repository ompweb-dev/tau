import assert from "node:assert/strict";
import test from "node:test";

const {
  createChildProcessEnvironment,
  isHostRuntimeVariable,
  isTauSecretVariable,
  sanitizeProjectCommandEnvironment,
  TAU_SECRET_ENV_VARS,
} = await import("./project-command-env.ts");

test("strips the host runtime variables", () => {
  assert.equal(isHostRuntimeVariable("PORT", "linux"), true);
  assert.equal(isHostRuntimeVariable("port", "win32"), true);
  assert.equal(isHostRuntimeVariable("NODE_ENV", "linux"), true);
  // A user's own NEXT_* settings are meant for the project's tools, not the tau server.
  assert.equal(isHostRuntimeVariable("NEXT_PUBLIC_FOO", "linux"), false);
  assert.equal(isHostRuntimeVariable("PATH", "linux"), false);
  assert.equal(isHostRuntimeVariable("NEXTTLS", "linux"), false);

  const env = sanitizeProjectCommandEnvironment({
    PATH: "/usr/bin",
    PORT: "30188",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    PROJECT: "keep-me",
  }, "linux");
  assert.deepEqual(env, { PATH: "/usr/bin", NEXT_TELEMETRY_DISABLED: "1", PROJECT: "keep-me" });
});

test("strips tau's own secrets from a child environment", () => {
  // The whole point of issue #239: an agent running `env` inside a session
  // must not be able to print anything that grants access to this server.
  for (const name of TAU_SECRET_ENV_VARS) {
    assert.equal(isTauSecretVariable(name, "linux"), true, name);
  }
  assert.equal(isTauSecretVariable("tau_password_hash", "win32"), true);
  // Configuration, not a secret: the launcher and update plumbing rely on it.
  for (const name of ["TAU_OMP_BIN", "TAU_PORT", "TAU_HOSTNAME", "TAU_PACKAGE_DIR", "TAU_LAUNCHER_PID", "TAU_NAME"]) {
    assert.equal(isTauSecretVariable(name, "linux"), false, name);
  }

  const env = sanitizeProjectCommandEnvironment({
    PATH: "/usr/bin",
    TAU_PASSWORD: "hunter2",
    TAU_PASSWORD_HASH: "scrypt$15$8$1$aaaa$bbbb",
    TAU_TRUSTED_HEADER_SECRET: "proxy-secret",
    TAU_TRUSTED_HEADER_SHA256: "a".repeat(64),
    TAU_OMP_BIN: "/usr/local/bin/omp",
    TAU_PORT: "30187",
    HOME: "/home/u",
  }, "linux");
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    TAU_OMP_BIN: "/usr/local/bin/omp",
    TAU_PORT: "30187",
    HOME: "/home/u",
  });
});

test("matches secret names case-insensitively on Windows only", () => {
  assert.equal(isTauSecretVariable("tau_password_hash", "win32"), true);
  assert.equal(isTauSecretVariable("tau_password_hash", "linux"), false);
  // Host runtime names are case-insensitive on Windows for the same reason.
  assert.equal(isHostRuntimeVariable("Port", "win32"), true);
  assert.equal(isHostRuntimeVariable("Port", "linux"), false);
});

test("builds a fresh environment that never mutates the parent", () => {
  const base = { PATH: "/usr/bin", TAU_PASSWORD_HASH: "scrypt$hash", TAU_PORT: "30187" };
  const env = createChildProcessEnvironment({ FORCE_COLOR: "0", LC_ALL: "C" }, base, "linux");
  assert.deepEqual(env, { PATH: "/usr/bin", TAU_PORT: "30187", FORCE_COLOR: "0", LC_ALL: "C" });
  // The parent object is untouched, and the child cannot re-add a secret
  // through the additions either.
  assert.deepEqual(base, { PATH: "/usr/bin", TAU_PASSWORD_HASH: "scrypt$hash", TAU_PORT: "30187" });
  const readded = createChildProcessEnvironment({ TAU_PASSWORD_HASH: "scrypt$again" }, base, "linux");
  assert.equal(readded.TAU_PASSWORD_HASH, undefined);
});

test("defaults to the current process environment and platform", () => {
  const previous = process.env.TAU_PASSWORD_HASH;
  const previousPort = process.env.TAU_PORT;
  process.env.TAU_PASSWORD_HASH = "scrypt$live";
  process.env.TAU_PORT = "30188";
  try {
    const env = createChildProcessEnvironment({ MARKER: "1" });
    assert.equal(env.MARKER, "1");
    assert.equal(env.TAU_PASSWORD_HASH, undefined);
    assert.equal(env.TAU_PORT, "30188");
  } finally {
    if (previous === undefined) delete process.env.TAU_PASSWORD_HASH;
    else process.env.TAU_PASSWORD_HASH = previous;
    if (previousPort === undefined) delete process.env.TAU_PORT;
    else process.env.TAU_PORT = previousPort;
  }
});
