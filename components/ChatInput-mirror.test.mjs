import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { render } = await import("@testing-library/react/pure.js");
const { ComposerMirror, splitLineMentions } = await import("./ChatInput-mirror.tsx");
const { buildFileLineMentionText } = await import("../lib/file-fuzzy.ts");

test("line-range mentions, as the file viewer writes them, split out of the composer text", () => {
  const text = `see ${buildFileLineMentionText("src/main.cpp", 28, 27)}and ${buildFileLineMentionText("a dir/x.ts", 3, 3)}and ${buildFileLineMentionText('say "hi".md', 5, 5)}and @src/other.ts plus git@github.com:22 and mail@host:22 and mail@host:22x`;
  assert.deepEqual(splitLineMentions(text).filter((part) => part.mention).map((part) => part.text), ["@src/main.cpp:27-28", "@\"a dir/x.ts\":3", "@'say \"hi\".md':5"]);
  assert.equal(splitLineMentions(text).map((part) => part.text).join(""), text, "the parts are the whole text");
});

test("the mirror paints chips under mentions, shows hints when empty, and nothing for plain text", () => {
  const textareaRef = { current: null };
  const mirror = (value) => render(React.createElement(ComposerMirror, { value, textareaRef, fontFamily: "inherit" })).container;
  const chips = mirror("look @src/main.cpp:27-28 here");
  assert.deepEqual([...chips.querySelectorAll(".composer-chip")].map((chip) => chip.textContent), ["@src/main.cpp:27-28"]);
  assert.equal(chips.querySelector(".composer-mirror").getAttribute("aria-hidden"), "true");
  assert.match(mirror("").textContent, /Ask anything@ files\/ commands! shell/);
  assert.equal(mirror("just words").querySelector(".composer-mirror"), null);
});

test("in forced colours the placeholder rule comes after the one that hides it, so the empty composer still reads", async () => {
  const css = await Bun.file(new URL("../app/globals.css", import.meta.url)).text();
  const hidden = css.indexOf(".composer-textarea::placeholder {\n  color: transparent;");
  const forced = css.lastIndexOf("@media (forced-colors: active)");
  assert.ok(hidden > 0 && forced > hidden && css.indexOf("color: GrayText", forced) > forced);
});
