import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ansi.ts");
}

test("strips ANSI escape sequences", async () => {
  const { stripAnsi } = await loadSubject();

  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("answer\x1b_pi:c\x07"), "answer");
});

test("parses ANSI style segments and reset codes", async () => {
  const { parseAnsiLine } = await loadSubject();

  assert.deepEqual(parseAnsiLine("\x1b[31;1;44mhot\x1b[0m cold"), [
    { text: "hot", style: { color: "#dc2626", fontWeight: 700, background: "#2563eb" } },
    { text: " cold", style: {} },
  ]);
});

test("maps 256-color SGR codes", async () => {
  const { ansi256Color, parseAnsiLine } = await loadSubject();

  assert.equal(ansi256Color(196), "rgb(255, 0, 0)");
  assert.deepEqual(parseAnsiLine("\x1b[38;5;196mred"), [
    { text: "red", style: { color: "rgb(255, 0, 0)" } },
  ]);
});

test("drops non-SGR escape sequences from styled text", async () => {
  const { parseAnsiLine } = await loadSubject();

  assert.deepEqual(parseAnsiLine("\x1b[32m\x1b]8;;https://x.test\x07link\x1b]8;;\x07\x1b[39m done\x1b_pi:c\x07"), [
    { text: "link", style: { color: "#16a34a" } },
    { text: " done", style: {} },
  ]);
});
