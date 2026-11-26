import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { FileExplorer } = await import("./FileExplorer.tsx");

function render(props = {}) {
  return renderToStaticMarkup(
    React.createElement(FileExplorer, {
      cwd: "/tmp/project",
      onOpenFile() {},
      ...props,
    }),
  );
}

test("the Files tab always has its search field", () => {
  const html = render();
  assert.match(html, /aria-label="(Search files|fileExplorer\.searchFiles)"/);
  assert.match(html, /placeholder="(Search files\.\.\.|fileExplorer\.searchPlaceholder)"/);
});

test("keeps the regular file tree visible while the search query is empty", () => {
  // An open panel with no query must not hide the tree behind an empty
  // search-results state.
  const open = render();
  assert.match(open, /role="tree"/);
  assert.match(open, /(Loading files\.\.\.|fileExplorer\.loadingFiles)/);
  assert.doesNotMatch(open, /(No matching files|fileExplorer\.noMatchingFiles)/);
});
