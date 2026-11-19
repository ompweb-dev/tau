import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

// The daemon's `auth` op over a fake shared utility pi (lib/omp/rpc-utility.ts reads it from globalThis).
const { createDaemonAuth } = await import("./daemon-auth.ts");
const calls = [];
let providers;
beforeEach(() => {
  calls.length = 0;
  globalThis.__ompUtilityRpcState = {
    proc: { isAlive: true, callExtension: async (command, args) => { calls.push(args); return args.action === "providers" ? { providers } : {}; }, dispose: async () => {} },
    idleTimer: null,
    queue: Promise.resolve(),
  };
});
const provider = (id, configured) => ({ id, name: id, oauth: false, apiKeyLogin: true, stored: null, configured, custom: false, models: 1 });

test("authenticated providers are cached until a key or logout through this daemon", async () => {
  const auth = createDaemonAuth();
  providers = [provider("groq", true), provider("openai", false)];
  assert.deepEqual(await auth.run({ action: "authenticated" }), { providers: ["groq"] });
  providers = [provider("groq", true), provider("openai", true)];
  assert.deepEqual(await auth.run({ action: "authenticated" }), { providers: ["groq"] }, "cached");
  await auth.run({ action: "setApiKey", provider: "openai", key: " sk " });
  assert.deepEqual(calls.at(-1), { action: "api_key", provider: "openai", key: "sk" });
  assert.deepEqual(await auth.run({ action: "authenticated" }), { providers: ["groq", "openai"] });
  auth.stop();
});

test("provider ids, keys and actions are checked before pi sees them", async () => {
  const auth = createDaemonAuth();
  for (const args of [{ action: "logout", provider: "../x" }, { action: "logout" }, { action: "setApiKey", provider: "groq", key: "" }, { action: "nope" }]) {
    await assert.rejects(auth.run(args), { status: 400 });
  }
  await assert.rejects(auth.run({ action: "loginPoll", loginId: "missing" }), { status: 404, code: "login_no_pending" });
  assert.deepEqual(calls, []);
  auth.stop();
});
