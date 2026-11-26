import assert from "node:assert/strict";
import test from "node:test";

test("the overlay hook and the overlay CSS switch at the same width", async () => {
  const hook = await Bun.file(new URL("./useIsCompactOverlay.ts", import.meta.url)).text();
  const css = await Bun.file(new URL("../app/globals.css", import.meta.url)).text();
  const query = hook.match(/COMPACT_OVERLAY_QUERY = "\((.+)\)"/)[1];
  const blocks = [...css.matchAll(/@media \(min-width: 641px\) and \(([^)]+)\) \{/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2);
  for (const block of blocks) assert.equal(block, query);
});
