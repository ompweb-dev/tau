import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mock } from "bun:test";

// Real /api/auth/login/[provider] handlers over the real daemon side (createDaemonAuth), whose pi is a fake that sends
// what lib/pi/tau-extension.ts's `/tau_auth login` sends. The hub's `auth` op calls the daemon side directly.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "tau-login-"));

const runners = [];
class FakePi {
  constructor(onFrame) {
    runners.push(this);
    this.onFrame = onFrame;
    this.sent = [];
    this.calls = [];
    this.disposed = false;
    this.login = Promise.withResolvers();
  }
  emit(frame) { this.onFrame(frame); }
  waitReady() { return Promise.resolve(); }
  callExtension(command, args) { this.calls.push([command, args]); return this.login.promise; }
  sendFrame(frame) { this.sent.push(frame); }
  dispose() { this.disposed = true; this.login.reject(new Error("pi exited")); return Promise.resolve(); }
}
const { createDaemonAuth } = await import("./hosts/daemon-auth.ts");
const daemon = createDaemonAuth({ spawn: (onFrame) => new FakePi(onFrame) });
const ops = [];
const hubPath = join(import.meta.dir, "hosts/hub.ts");
const realHub = { ...(await import(hubPath)) };
mock.module(hubPath, () => ({ ...realHub, authOp: async (hostId, args) => { ops.push([hostId, args.action]); return daemon.run(args); } }));
const route = await import("../app/api/auth/login/[provider]/route.ts");
after(() => { mock.module(hubPath, () => realHub); daemon.stop(); });

const url = "http://localhost/api/auth/login/anthropic";

/** Opens the SSE stream (which starts the fake pi) and returns its event reader. */
async function openLogin(query = "", signal) {
  const res = await route.GET(new Request(url + query, { signal }), { params: Promise.resolve({ provider: "anthropic" }), disableIdleTimeout: () => {} });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith("data: ")) return JSON.parse(block.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value);
    }
  };
}
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
const prompt = (id, value) => ({ type: "ui_request", id, method: "input", args: ["__tau_auth_prompt__", JSON.stringify(value)] });

const submit = (token, code, provider = "anthropic") =>
  route.POST(
    new Request(url, { method: "POST", body: JSON.stringify({ token, code }) }),
    { params: Promise.resolve({ provider }) },
  );

test("pi's login steps map to the browser's SSE events and a pasted code answers pi's prompt", async () => {
  const next = await openLogin();
  await until(() => runners.length === 1 && runners[0].calls.length === 1);
  const pi = runners[0];
  assert.deepEqual(pi.calls, [["tau_auth", { action: "login", provider: "anthropic" }]]);
  pi.emit({ type: "tau_auth_event", replyId: "r", event: { type: "auth_url", url: "https://auth.test/x", instructions: "Sign in" } });
  const auth = await next();
  assert.deepEqual({ ...auth, token: undefined }, { type: "auth", url: "https://auth.test/x", instructions: "Sign in", token: undefined });

  pi.emit({ type: "tau_auth_event", replyId: "r", event: { type: "progress", message: "Waiting" } });
  assert.deepEqual(await next(), { type: "progress", message: "Waiting" });

  pi.emit(prompt("p1", { type: "manual_code", message: "Paste the code", placeholder: "code" }));
  assert.deepEqual(await next(), { type: "prompt_request", message: "Paste the code", placeholder: "code", token: auth.token });
  assert.equal((await submit(auth.token, "abc")).status, 200);
  assert.deepEqual(pi.sent, [{ type: "ui_response", id: "p1", value: "abc" }]);

  pi.login.resolve({});
  assert.deepEqual(await next(), { type: "success" });
  assert.equal(await next(), null);
  assert.ok(pi.disposed, "the login's pi stops");
  assert.equal((await submit(auth.token, "late")).status, 404);
  assert.ok(ops.every(([hostId]) => hostId === "local"), "no hostId means this machine");
});

test("a choice and a device code reach the browser; an error ends the stream", async () => {
  const next = await openLogin("?hostId=local");
  await until(() => runners.length === 2 && runners[1].calls.length === 1);
  const pi = runners[1];
  pi.emit(prompt("s1", { type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "copy_code", label: "Headless" }] }));
  const select = await next();
  assert.deepEqual({ ...select, token: undefined }, { type: "select_request", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "copy_code", label: "Headless" }], token: undefined });
  assert.equal((await submit(select.token, "copy_code")).status, 200);
  assert.deepEqual(pi.sent, [{ type: "ui_response", id: "s1", value: "copy_code" }]);
  assert.equal((await submit(select.token, "again")).status, 502, "nothing waits for input any more");

  pi.emit({ type: "tau_auth_event", event: { type: "device_code", userCode: "AB-CD", verificationUri: "https://dev.test", intervalSeconds: 5 } });
  assert.deepEqual(await next(), { type: "device_code", userCode: "AB-CD", verificationUri: "https://dev.test", intervalSeconds: 5, expiresInSeconds: null });
  pi.login.reject(new Error("bad code"));
  assert.deepEqual(await next(), { type: "error", message: "bad code" });
});

test("a token is only accepted on its own provider's route", async () => {
  const next = await openLogin();
  await until(() => runners.length === 3 && runners[2].calls.length === 1);
  runners[2].emit(prompt("p", { type: "text", message: "Code" }));
  const { token } = await next();
  assert.equal((await submit(token, "x", "anthropic-other")).status, 400);
  assert.deepEqual(runners[2].sent, []);
  runners[2].login.resolve({});
  assert.deepEqual(await next(), { type: "success" });
});

test("closing the stream cancels the login on the host", async () => {
  const controller = new AbortController();
  const next = await openLogin("", controller.signal);
  await until(() => runners.length === 4 && runners[3].calls.length === 1);
  controller.abort();
  await until(() => runners[3].disposed);
  assert.ok(ops.some(([, action]) => action === "loginCancel"));
  void next;
});

test("an invalid provider id is refused before anything starts", async () => {
  const res = await route.GET(new Request("http://localhost/api/auth/login/x%20y"), { params: Promise.resolve({ provider: "x y" }), disableIdleTimeout: () => {} });
  assert.equal(res.status, 400);
  assert.equal(runners.length, 4);
});
