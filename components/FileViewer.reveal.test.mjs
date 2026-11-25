import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import React from "react";
import test, { afterEach } from "node:test";
const { render, cleanup, waitFor } = await import("@testing-library/react/pure.js");
const { FileViewer } = await import("./FileViewer.tsx");
const originalFetch = globalThis.fetch;
const originalWorker = globalThis.Worker;
const originalScroll = Element.prototype.scrollIntoView;
afterEach(() => {
  cleanup(); globalThis.fetch = originalFetch; globalThis.Worker = originalWorker; delete window.matchMedia;
  Element.prototype.scrollIntoView = originalScroll;
});

test("a revealed line shows the source, scrolls to the line and marks it, once per request", async () => {
  globalThis.Worker = class { onmessage = null; onerror = null; postMessage() {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const scrolled = [];
  Element.prototype.scrollIntoView = function () { scrolled.push(this.dataset.lineNumber); };
  globalThis.fetch = async (url) => String(url).startsWith("/api/git/")
    ? Response.json({ supported: false })
    : Response.json({ content: "# Title\n\none\ntwo\nthree\n", language: "markdown", size: 24 });
  const props = { filePath: "/w/notes.md", cwd: "/w", hostId: "local" };
  const view = render(React.createElement(FileViewer, { ...props, revealLine: { line: 4, seq: 1 } }));
  // A markdown file opens in its preview, except when a line is to be revealed.
  await waitFor(() => assert.deepEqual(scrolled, ["4"]));
  const marked = () => [...view.container.querySelectorAll(".file-source-line.is-revealed")].map((line) => line.dataset.lineNumber);
  assert.deepEqual(marked(), ["4"]);
  // The same request again does nothing; a new one moves the mark.
  view.rerender(React.createElement(FileViewer, { ...props, revealLine: { line: 4, seq: 1 } }));
  view.rerender(React.createElement(FileViewer, { ...props, revealLine: { line: 5, seq: 2 } }));
  await waitFor(() => assert.deepEqual(scrolled, ["4", "5"]));
  assert.deepEqual(marked(), ["5"]);
});
