import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";

const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { providerInitials } = await import("./ModelsConfig.tsx");
const { ApiKeyDetail, RetryFallbackDetail } = await import("./ModelsConfig-panels.tsx");

afterEach(cleanup);

const runtimeModel = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  name: "GPT 5.6 Sol",
  thinkingLevels: ["off", "low", "medium", "high"],
};

async function chooseFallback(user, effort) {
  await user.click(await screen.findByRole("combobox", { name: "Select a fallback model" }));
  await user.click(await screen.findByRole("option", { name: "openai-codex/gpt-5.6-sol" }));
  await user.click(screen.getByRole("combobox", { name: "Thinking levels" }));
  await user.click(await screen.findByRole("option", { name: effort }));
}

test("provider glyphs derive from arbitrary runtime provider ids", () => {
  assert.equal(providerInitials("acme-provider"), "AP");
  assert.equal(providerInitials("my_custom_gateway"), "MC");
  assert.equal(providerInitials("provider"), "P");
  assert.equal(providerInitials(""), "?");
});

test("fallback chains can select a model effort", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body));
      return Response.json(JSON.parse(init.body));
    }
    return Response.json({ settings: {} });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "high");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await waitFor(() => assert.deepEqual(
    writes.at(-1).settings.retry.fallbackChains.default,
    ["openai-codex/gpt-5.6-sol:high"],
  ));
});

test("fallback chains expose the runtime off effort", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body));
      return Response.json(JSON.parse(init.body));
    }
    return Response.json({ settings: {} });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "off");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await waitFor(() => assert.deepEqual(
    writes.at(-1).settings.retry.fallbackChains.default,
    ["openai-codex/gpt-5.6-sol:off"],
  ));
});

test("fallback chains allow an effort variant after the model default", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body));
      return Response.json(JSON.parse(init.body));
    }
    return Response.json({ settings: { retry: { fallbackChains: { default: ["openai-codex/gpt-5.6-sol"] } } } });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "high");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await waitFor(() => assert.deepEqual(
    writes.at(-1).settings.retry.fallbackChains.default,
    ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-sol:high"],
  ));
});

test("fallback chains reject an exact duplicate selector", async (t) => {
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(init.body));
      return Response.json(JSON.parse(init.body));
    }
    return Response.json({ settings: { retry: { fallbackChains: { default: ["openai-codex/gpt-5.6-sol:high"] } } } });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "high");

  assert.equal(screen.getByRole("button", { name: "Add" }).disabled, true);
  assert.deepEqual(writes, []);
});

test("a failed fallback save restores the confirmed chain", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init?.method === "PUT") return Response.json({ error: "save failed" }, { status: 500 });
    return Response.json({ settings: {} });
  });

  render(createElement(RetryFallbackDetail, { models: [runtimeModel] }));
  const user = userEvent.setup();
  await chooseFallback(user, "high");
  await user.click(screen.getByRole("button", { name: "Add" }));

  await screen.findByRole("alert");
  assert.equal(screen.queryByText("openai-codex/gpt-5.6-sol:high"), null);
  assert.ok(screen.getByText("No explicit chain. OMP uses the default chain when available."));
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
