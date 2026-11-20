import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { McpConfig } = await import("./McpConfig.tsx");
afterEach(cleanup);

test("MCP lists the configured servers from configuration only: no session, no live status, no prompt", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([options?.method ?? "GET", String(url)]);
    return Response.json({ servers: [], inventory: [
      { name: "demo", source: "User level", sourcePath: "/fixture/mcp.json", status: "configured", type: "stdio" },
      { name: "off", source: "User level", sourcePath: "/fixture/mcp.json", status: "disabled", type: "http" },
    ] });
  });
  render(createElement(McpConfig, { cwd: null }));
  assert.ok(await screen.findByText("demo"));
  assert.ok(screen.getByText("off"));
  assert.equal(screen.queryByRole("switch"), null);
  assert.equal(screen.queryByRole("button", { name: "Reload MCP" }), null);
  assert.deepEqual(requests, [["GET", "/api/mcp?"]]);
});
