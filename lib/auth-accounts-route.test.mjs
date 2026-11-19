import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { mock } from "bun:test";

// Real /api/auth/accounts/[provider] and /api/auth/providers handlers; the hub's `auth` op is a fake host.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "tau-accounts-"));
const { HostOpError } = await import("./hosts/link-protocol.ts");
let reply;
const sent = [];
const hubPath = join(import.meta.dir, "hosts/hub.ts");
const realHub = { ...(await import(hubPath)) };
mock.module(hubPath, () => ({ ...realHub, authOp: async (hostId, args) => { sent.push([hostId, args]); return reply(args); } }));
const accounts = await import("../app/api/auth/accounts/[provider]/route.ts");
const providers = await import("../app/api/auth/providers/route.ts");
const allProviders = await import("../app/api/auth/all-providers/route.ts");
const apiKey = await import("../app/api/auth/api-key/[provider]/route.ts");
after(() => mock.module(hubPath, () => realHub));
beforeEach(() => { sent.length = 0; });

const entry = (id, fields = {}) => ({ id, name: id.toUpperCase(), oauth: false, apiKeyLogin: true, stored: null, configured: false, custom: false, models: 2, ...fields });
const list = [
  entry("anthropic", { oauth: true, stored: "oauth", configured: true }),
  entry("openai", { oauth: true, stored: "api_key", configured: true }),
  entry("groq"),
  entry("mine", { custom: true, configured: true }),
  { id: "bad id", name: "x" },
];
const params = (provider) => ({ params: Promise.resolve({ provider }) });

test("GET lists the one stored credential for a provider on the asked host, never a secret", async () => {
  reply = () => ({ providers: list });
  const body = await (await accounts.GET(new Request("http://localhost/api/auth/accounts/anthropic?hostId=box"), params("anthropic"))).json();
  assert.deepEqual(sent, [["box", { action: "providers" }]]);
  assert.deepEqual(body, { supported: true, accounts: [{ credentialId: 0, label: "ANTHROPIC", detail: "OAuth", type: "oauth" }] });
  const none = await (await accounts.GET(new Request("http://localhost/api/auth/accounts/groq"), params("groq"))).json();
  assert.deepEqual(none, { supported: true, accounts: [] });
  assert.equal(sent[1][0], "local");
});

test("DELETE logs the provider out on that host; any other credential id or provider id is refused unsent", async () => {
  reply = () => ({});
  const res = await accounts.DELETE(new Request("http://localhost/api/auth/accounts/openai?credentialId=0&hostId=box", { method: "DELETE" }), params("openai"));
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [["box", { action: "logout", provider: "openai" }]]);
  sent.length = 0;
  for (const id of ["", "1", "abc"]) {
    assert.equal((await accounts.DELETE(new Request(`http://localhost/api/auth/accounts/openai?credentialId=${id}`, { method: "DELETE" }), params("openai"))).status, 400);
  }
  assert.equal((await accounts.DELETE(new Request("http://localhost/api/auth/accounts/x?credentialId=0", { method: "DELETE" }), params("../x"))).status, 400);
  assert.deepEqual(sent, []);
});

test("host failures keep their status and code", async () => {
  reply = () => { throw new HostOpError(503, "host_offline", "Box is offline"); };
  const res = await providers.GET(new Request("http://localhost/api/auth/providers?hostId=box"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { providers: [], error: "Box is offline", code: "host_offline" });
});

test("the provider lists split account logins from API-key providers", async () => {
  reply = () => ({ providers: list });
  assert.deepEqual((await (await providers.GET(new Request("http://localhost/api/auth/providers"))).json()).providers, [
    { id: "anthropic", name: "ANTHROPIC", usesCallbackServer: false, loggedIn: true },
    { id: "openai", name: "OPENAI", usesCallbackServer: false, loggedIn: false },
  ]);
  assert.deepEqual((await (await allProviders.GET(new Request("http://localhost/api/auth/all-providers"))).json()).providers.map((p) => [p.id, p.configured, p.stored]), [
    ["groq", false, null],
    ["openai", true, "api_key"],
  ]);
});

test("an API key goes to the host trimmed; an empty one is refused", async () => {
  reply = () => ({});
  const post = (body) => apiKey.POST(new Request("http://localhost/api/auth/api-key/groq?hostId=box", { method: "POST", body: JSON.stringify(body) }), params("groq"));
  assert.equal((await post({ key: "  gsk-1  " })).status, 200);
  assert.deepEqual(sent, [["box", { action: "setApiKey", provider: "groq", key: "gsk-1" }]]);
  assert.equal((await post({ key: " " })).status, 400);
  assert.equal(sent.length, 1);
});
