import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_TAB_HISTORY, step, stepTarget, visit } from "./tab-history.ts";

const open = (...ids) => new Set(ids);

test("visiting tabs builds the back side and clears the forward side", () => {
  let history = visit(visit(visit(EMPTY_TAB_HISTORY, "a"), "b"), "c");
  assert.deepEqual(history, { back: ["a", "b"], forward: [], current: "c" });
  assert.equal(visit(history, "c"), history, "the shown tab again changes nothing");
  history = step(history, -1, open("a", "b", "c"));
  assert.deepEqual(history, { back: ["a"], forward: ["c"], current: "b" });
  assert.deepEqual(visit(history, "d"), { back: ["a", "b"], forward: [], current: "d" });
});

test("stepping back and forward skips tabs that were closed", () => {
  const history = visit(visit(visit(visit(EMPTY_TAB_HISTORY, "a"), "b"), "c"), "d");
  assert.equal(stepTarget(history, -1, open("a", "d")), "a");
  const back = step(history, -1, open("a", "d"));
  assert.deepEqual(back, { back: [], forward: ["d"], current: "a" });
  assert.equal(stepTarget(back, -1, open("a", "d")), null);
  assert.equal(stepTarget(back, 1, open("a", "d")), "d");
  assert.deepEqual(step(back, 1, open("a", "d")), { back: ["a"], forward: [], current: "d" });
  assert.equal(step(back, 1, open("a")), back, "nothing open that way: unchanged");
});

test("a group with nothing shown keeps its history", () => {
  const history = visit(visit(EMPTY_TAB_HISTORY, "a"), null);
  assert.deepEqual(history, { back: [], forward: [], current: null });
  assert.deepEqual(visit(visit(visit(EMPTY_TAB_HISTORY, "a"), "b"), null), { back: ["a"], forward: [], current: null });
});

test("each side keeps at most 50 tabs", () => {
  let history = EMPTY_TAB_HISTORY;
  for (let index = 0; index < 60; index += 1) history = visit(history, `t${index}`);
  assert.equal(history.back.length, 50);
  assert.equal(history.back[0], "t9");
});
