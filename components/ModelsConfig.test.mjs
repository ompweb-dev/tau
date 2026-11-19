import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { providerInitials } = await import("./ModelsConfig.tsx");
const { ApiKeyDetail } = await import("./ModelsConfig-panels.tsx");

afterEach(cleanup);

test("provider glyphs derive from arbitrary runtime provider ids", () => {
  assert.equal(providerInitials("acme-provider"), "AP");
  assert.equal(providerInitials("my_custom_gateway"), "MC");
  assert.equal(providerInitials("provider"), "P");
  assert.equal(providerInitials(""), "?");
});

test("an API key is saved to and removed from the selected host's pi", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push([String(url), init?.method, init?.body ? JSON.parse(init.body) : undefined]);
    return Response.json({ ok: true });
  });
  let refreshed = 0;
  const provider = { id: "groq", displayName: "Groq", configured: true, modelCount: 3, apiKeyLogin: true, stored: "api_key" };
  render(createElement(ApiKeyDetail, { provider, hostId: "box", onRefresh: () => refreshed++ }));
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("API key for Groq"), "gsk-1");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => assert.equal(refreshed, 1));
  assert.deepEqual(calls[0], ["/api/auth/api-key/groq?hostId=box", "POST", { key: "gsk-1" }]);
  assert.equal(screen.getByLabelText("API key for Groq").value, "", "the typed key is not kept");
  await user.click(screen.getByRole("button", { name: "Remove stored key" }));
  await waitFor(() => assert.equal(refreshed, 2));
  assert.deepEqual(calls[1], ["/api/auth/api-key/groq?hostId=box", "DELETE", undefined]);
});
