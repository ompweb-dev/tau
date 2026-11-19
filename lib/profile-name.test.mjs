import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isValidProfileName } = await jiti.import("./profile-name.ts");

test("accepts profile names omp allows", () => {
  assert.equal(isValidProfileName(""), true); // empty = no profile
  assert.equal(isValidProfileName("work"), true);
  assert.equal(isValidProfileName("nova-insight"), true);
  assert.equal(isValidProfileName("a"), true);
  assert.equal(isValidProfileName("9lives"), true);
  assert.equal(isValidProfileName("a".repeat(64)), true);
  assert.equal(isValidProfileName("team.config_v2-2026"), true);
});

test("rejects profile names omp rejects at startup", () => {
  assert.equal(isValidProfileName("nova insight"), false); // space — the 500 repro
  assert.equal(isValidProfileName("work\n"), false);
  assert.equal(isValidProfileName("Nova"), false); // uppercase
  assert.equal(isValidProfileName("工作"), false); // non-ASCII
  assert.equal(isValidProfileName("-lead"), false); // dash-leading (flag smuggling)
  assert.equal(isValidProfileName("a".repeat(65)), false); // too long
  assert.equal(isValidProfileName(".hidden"), false); // must start with letter/digit
  assert.equal(isValidProfileName("trailing."), false); // cannot end with '.'
});

test("rejects Windows reserved device names with or without extension", () => {
  assert.equal(isValidProfileName("con"), false);
  assert.equal(isValidProfileName("nul"), false);
  assert.equal(isValidProfileName("com1"), false);
  assert.equal(isValidProfileName("lpt9"), false);
  assert.equal(isValidProfileName("con.txt"), false);
  assert.equal(isValidProfileName("aux.settings"), false);
  assert.equal(isValidProfileName("console"), true); // only exact base names are reserved
  assert.equal(isValidProfileName("com1x"), true);
});
