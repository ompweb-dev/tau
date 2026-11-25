import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import React from "react";
import test, { afterEach } from "node:test";
const { render, cleanup, waitFor, screen, fireEvent } = await import("@testing-library/react/pure.js");
const { FileViewer } = await import("./FileViewer.tsx");
const originalFetch = globalThis.fetch;
const originalWorker = globalThis.Worker;
const originalScroll = Element.prototype.scrollIntoView;
afterEach(() => {
  cleanup(); globalThis.fetch = originalFetch; globalThis.Worker = originalWorker; delete window.matchMedia;
  Element.prototype.scrollIntoView = originalScroll;
});

/** A markdown file whose reads count up, and the lines scrolled to. */
function setup(language = "markdown") {
  globalThis.Worker = class { onmessage = null; onerror = null; postMessage() {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const scrolled = [];
  Element.prototype.scrollIntoView = function () { scrolled.push(this.dataset.lineNumber); };
  const reads = { count: 0 };
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/git/")) return Response.json({ supported: false });
    reads.count++;
    return Response.json({ content: "# Title\n\none\ntwo\nthree\n", language, size: 24 });
  };
  return { scrolled, reads };
}
const props = { filePath: "/w/notes.md", cwd: "/w", hostId: "local" };
const marked = (view) => [...view.container.querySelectorAll(".file-source-line.is-revealed")].map((line) => line.dataset.lineNumber);

test("a revealed line shows the source, scrolls to the line and marks it, once per request", async () => {
  const { scrolled } = setup();
  const done = [];
  const onRevealDone = (seq) => done.push(seq);
  const view = render(React.createElement(FileViewer, { ...props, revealLine: { line: 4, seq: 1 }, onRevealDone }));
  // A markdown file opens in its preview, except when a line is to be revealed.
  await waitFor(() => assert.deepEqual(scrolled, ["4"]));
  assert.deepEqual(marked(view), ["4"]);
  assert.deepEqual(done, [1]);
  // The same request again does nothing; a new one moves the mark.
  view.rerender(React.createElement(FileViewer, { ...props, revealLine: { line: 4, seq: 1 }, onRevealDone }));
  view.rerender(React.createElement(FileViewer, { ...props, revealLine: { line: 5, seq: 2 }, onRevealDone }));
  await waitFor(() => assert.deepEqual(scrolled, ["4", "5"]));
  assert.deepEqual(marked(view), ["5"]);
  assert.deepEqual(done, [1, 2]);
});

test("a line the file no longer has is given up, and Preview stays usable", async () => {
  const { scrolled } = setup();
  const done = [];
  const view = render(React.createElement(FileViewer, { ...props, revealLine: { line: 99, seq: 1 }, onRevealDone: (seq) => done.push(seq) }));
  await waitFor(() => assert.deepEqual(done, [1]));
  assert.deepEqual(scrolled, []);
  const preview = screen.getByRole("button", { name: "Preview" });
  fireEvent.click(preview);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(view.container.querySelector(".file-source-line"), null, "Preview is not forced back to the source");
});

test("a reveal on a tab shown again waits for the reloaded content", async () => {
  // Plain text, so the first activation already shows numbered lines to be stale.
  const { scrolled, reads } = setup("text");
  const view = render(React.createElement(FileViewer, props));
  await waitFor(() => assert.equal(reads.count, 1));
  view.rerender(React.createElement(FileViewer, { ...props, active: false }));
  view.rerender(React.createElement(FileViewer, { ...props, active: true, revealLine: { line: 3, seq: 1 } }));
  await waitFor(() => assert.equal(reads.count, 2));
  await waitFor(() => assert.deepEqual(marked(view), ["3"]), "the mark is on the lines rendered after the reload");
  assert.deepEqual(scrolled, ["3"]);
});
