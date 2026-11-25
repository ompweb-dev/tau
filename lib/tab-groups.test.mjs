import assert from "node:assert/strict";
import test from "node:test";
const { initialLayout, groupsOf, groupOfTab, reconcileTabs, activateTab, moveTab, splitGroup, resizeSplit, moveBoundary } = await import("./tab-groups.ts");

const tabsOf = (layout) => groupsOf(layout).map((group) => group.tabs);

test("new tabs join the target group and closed ones leave, their neighbour shown", () => {
  let layout = reconcileTabs(initialLayout(), ["a", "b", "c"], null);
  layout = activateTab(layout, "b");
  layout = reconcileTabs(layout, ["a", "c"], null);
  assert.deepEqual(tabsOf(layout), [["a", "c"]]);
  assert.equal(groupsOf(layout)[0].active, "c");
});

test("splitting moves the shown tab after the others, keeping the group (and so its mount)", () => {
  let layout = activateTab(reconcileTabs(initialLayout(), ["a", "b"], null), "b");
  const source = groupsOf(layout)[0].id;
  layout = splitGroup(layout, source, "row");
  assert.equal(layout.kind, "split");
  assert.equal(layout.dir, "row");
  assert.deepEqual(tabsOf(layout), [["a"], ["b"]]);
  assert.equal(groupOfTab(layout, "b").id, source);
  assert.equal(groupOfTab(layout, "a").active, "a");
  // A single tab cannot be split off.
  assert.equal(splitGroup(layout, source, "row"), layout);
});

test("a split in the same direction shares the source's space", () => {
  let layout = activateTab(reconcileTabs(initialLayout(), ["a", "b", "c"], null), "c");
  layout = activateTab(splitGroup(layout, groupsOf(layout)[0].id, "row"), "b");
  layout = splitGroup(layout, groupsOf(layout)[0].id, "row");
  assert.deepEqual(tabsOf(layout), [["a"], ["b"], ["c"]]);
  assert.deepEqual(layout.sizes, [0.25, 0.25, 0.5]);
  // Another direction nests a split.
  layout = reconcileTabs(layout, ["a", "b", "c", "d"], groupOfTab(layout, "c").id);
  layout = splitGroup(layout, groupOfTab(layout, "c").id, "column");
  assert.equal(layout.children[2].kind, "split");
  assert.equal(layout.children[2].dir, "column");
});

test("a group left empty goes away and its split collapses", () => {
  let layout = activateTab(reconcileTabs(initialLayout(), ["a", "b"], null), "b");
  layout = splitGroup(layout, groupsOf(layout)[0].id, "row");
  layout = reconcileTabs(layout, ["a"], null);
  assert.equal(layout.kind, "group");
  assert.deepEqual(layout.tabs, ["a"]);
  // A group leaving a three-way split gives its share to the others.
  layout = activateTab(reconcileTabs(layout, ["a", "b", "c"], null), "c");
  layout = splitGroup(layout, groupsOf(layout)[0].id, "row");
  layout = activateTab(layout, "b");
  layout = splitGroup(layout, groupsOf(layout)[0].id, "row");
  assert.deepEqual(layout.sizes, [0.25, 0.25, 0.5]);
  layout = reconcileTabs(layout, ["a", "c"], null);
  assert.deepEqual(layout.sizes, [1 / 3, 2 / 3]);
  // The last group stays, empty.
  layout = reconcileTabs(layout, [], null);
  assert.equal(layout.kind, "group");
  assert.deepEqual(layout.tabs, []);
});

test("moving a tab to another group shows it there and can empty its old group", () => {
  let layout = activateTab(reconcileTabs(initialLayout(), ["a", "b", "c"], null), "c");
  layout = splitGroup(layout, groupsOf(layout)[0].id, "row");
  const right = groupOfTab(layout, "c").id;
  layout = moveTab(layout, "a", right, "c");
  assert.deepEqual(tabsOf(layout), [["b"], ["a", "c"]]);
  assert.equal(groupOfTab(layout, "a").active, "a");
  layout = moveTab(layout, "b", right, null);
  assert.equal(layout.kind, "group");
  assert.deepEqual(layout.tabs, ["a", "c", "b"]);
});

test("resizing keeps every share at or above the minimum", () => {
  let layout = activateTab(reconcileTabs(initialLayout(), ["a", "b"], null), "b");
  layout = splitGroup(layout, groupsOf(layout)[0].id, "row");
  const sizes = moveBoundary([0.5, 0.5], 0, 0.6);
  assert.equal(sizes[0], 0.9);
  assert.ok(Math.abs(sizes[1] - 0.1) < 1e-9);
  assert.deepEqual(resizeSplit(layout, layout.id, sizes).sizes, sizes, "a resize to the limit applies");
  // A pair narrower than two minimums still moves, up to its middle.
  assert.deepEqual(moveBoundary([0.9, 0.0625, 0.0375], 1, -1), [0.9, 0.05, 0.05]);
  assert.equal(resizeSplit(layout, layout.id, [0.5, Number.NaN]), layout);
});
