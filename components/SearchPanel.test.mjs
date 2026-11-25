import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";
const { render, cleanup, waitFor, fireEvent, screen } = await import("@testing-library/react/pure.js");
const { SearchPanel } = await import("./SearchPanel.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("results group by file, open at their line, and follow the case toggle", async () => {
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(url);
    // The session's own cwd, searched instead of the panel's.
    return Response.json({ cwd: "/session", truncated: false, matches: [
      { path: "src/a.ts", line: 3, text: "  const needle = 1;", column: 8, length: 6 },
      { path: "src/a.ts", line: 9, text: "needle()", column: 0, length: 6 },
      { path: "README.md", line: 1, text: "# Needle", column: 2, length: 6 },
    ] });
  };
  const opened = [];
  render(React.createElement(SearchPanel, { cwd: "/w", hostId: "local", sourceSessionId: "s1", refreshKey: 0, client: "panel1", onOpenMatch: (...args) => opened.push(args) }));
  for (const value of ["n", "ne", "needle"]) {
    fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await waitFor(() => assert.ok(screen.getByRole("status").textContent.includes("3 results")));
  assert.equal(requests.length, 1, "typing is debounced into one request");
  const { client, ...sent } = Object.fromEntries(requests[0].searchParams);
  assert.deepEqual(sent, { cwd: "/w", hostId: "local", q: "needle", sessionId: "s1" });
  assert.equal(client, "panel1", "the panel names itself so only its own older search is stopped");
  assert.ok(screen.getByRole("status").textContent.includes("2 files"));
  assert.deepEqual([...document.querySelectorAll("mark")].map((mark) => mark.textContent), ["needle", "needle", "Needle"]);

  fireEvent.click(screen.getByRole("button", { name: /9\s*needle\(\)/ }));
  assert.deepEqual(opened, [["/session/src/a.ts", 9, "/session"]], "a result opens against the directory searched");

  const file = screen.getByRole("button", { name: /a\.ts/, expanded: true });
  fireEvent.click(file);
  assert.equal(file.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByRole("button", { name: /9\s*needle\(\)/ }), null);

  fireEvent.click(screen.getByRole("button", { name: "Match case" }));
  await waitFor(() => assert.equal(requests.length, 2));
  assert.equal(requests[1].searchParams.get("case"), "1");
});

test("a failed search shows the server's error", async () => {
  globalThis.fetch = async () => Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
  render(React.createElement(SearchPanel, { cwd: "/w", hostId: "local", refreshKey: 0, client: "panel1", onOpenMatch() {} }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "x" } });
  await waitFor(() => assert.ok(screen.getByRole("status").textContent.length > 0 && !screen.getByRole("status").textContent.includes("Searching")));
  assert.equal(document.querySelectorAll(".search-panel-match").length, 0);
});

test("an older answer arriving last never replaces the newer one", async () => {
  const pending = [];
  globalThis.fetch = (input) => new Promise((resolve) => {
    const q = new URL(String(input), "http://localhost").searchParams.get("q");
    pending.push(() => resolve(Response.json({ cwd: "/w", truncated: false, matches: [{ path: `${q}.ts`, line: 1, text: q, column: 0, length: q.length }] })));
  });
  render(React.createElement(SearchPanel, { cwd: "/w", hostId: "local", refreshKey: 0, client: "panel1", onOpenMatch() {} }));
  const box = screen.getByRole("searchbox");
  fireEvent.change(box, { target: { value: "old" } });
  await waitFor(() => assert.equal(pending.length, 1));
  fireEvent.change(box, { target: { value: "new" } });
  await waitFor(() => assert.equal(pending.length, 2));
  pending[1]();
  await waitFor(() => assert.ok(screen.getByRole("button", { name: /new\.ts/ })));
  pending[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screen.queryByRole("button", { name: /old\.ts/ }), null);
  assert.ok(screen.getByRole("button", { name: /new\.ts/ }));
});

test("an empty search that stopped early says so", async () => {
  globalThis.fetch = async () => Response.json({ cwd: "/w", truncated: true, matches: [] });
  render(React.createElement(SearchPanel, { cwd: "/w", hostId: "local", refreshKey: 0, client: "panel1", onOpenMatch() {} }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "x" } });
  await waitFor(() => assert.ok(screen.getByRole("status").textContent.includes("No results")));
  assert.ok(screen.getByRole("status").textContent.includes("first results only"));
});
