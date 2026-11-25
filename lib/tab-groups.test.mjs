import assert from "node:assert/strict";
import test from "node:test";
const { initialLayout, groupsOf, groupOfTab, reconcileTabs, activateTab, moveTab, splitGroup, resizeSplit, moveBoundary, boundaryRange, nextChatMounts, syncChatTabs } = await import("./tab-groups.ts");

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
  // A side already under the minimum never shrinks, and the other side can only grow.
  const near = (actual, expected) => assert.ok(actual.every((n, i) => Math.abs(n - expected[i]) < 1e-9), `${actual} ≉ ${expected}`);
  near(moveBoundary([0.8, 0.15, 0.05], 1, 0.1), [0.8, 0.15, 0.05]);
  near(moveBoundary([0.8, 0.15, 0.05], 1, -0.1), [0.8, 0.1, 0.1]);
  // Two narrow sides still move toward their middle.
  near(moveBoundary([0.9, 0.06, 0.04], 1, -0.05), [0.9, 0.05, 0.05]);
  // A side at or above the minimum never goes below it.
  near(moveBoundary([0.12, 0.05], 0, -0.1), [0.1, 0.07]);
  assert.equal(resizeSplit(layout, layout.id, [0.5, Number.NaN]), layout);
});

test("chat mount keys survive focus changes and a new chat's first send, and a bump remounts", () => {
  const shown = new Set();
  let mounts = { selected: null, sessionKey: 0, keys: {} };
  // A new chat (sessionKey bump) mounts under a fresh key.
  mounts = nextChatMounts(mounts, "new", 1, ["new"], shown);
  assert.equal(mounts.keys.new, "new~1");
  // Its first send turns it into a session without a bump: same key, though the new-chat tab is gone.
  mounts = nextChatMounts(mounts, "x", 1, ["x"], shown);
  assert.equal(mounts.keys.x, "new~1");
  assert.equal("new" in mounts.keys, false, "closed tabs keep no key");
  // Switching (with a bump) to a chat another group shows keeps both mounts.
  mounts = nextChatMounts(mounts, "y", 2, ["x", "y"], new Set(["x", "y"]));
  assert.equal(mounts.keys.y ?? "y", "y");
  assert.equal(mounts.keys.x, "new~1");
  // A bump on the same chat remounts it.
  mounts = nextChatMounts(mounts, "y", 3, ["x", "y"], new Set(["x", "y"]));
  assert.equal(mounts.keys.y, "y~3");
  // An identity change onto a chat that already has a key keeps that key.
  mounts = nextChatMounts(mounts, "x", 3, ["x", "y"], shown);
  assert.equal(mounts.keys.x, "new~1");
  assert.equal(mounts.keys.y, "y~3");
  mounts = nextChatMounts(mounts, "y", 3, ["x", "y"], shown);
  // Nothing changed: the same object.
  assert.equal(nextChatMounts(mounts, "y", 3, ["x", "y"], shown), mounts);
});

test("a group remembers the chat under the file it shows, until that chat leaves it", () => {
  let layout = reconcileTabs(initialLayout(), ["x", "f", "y"], null);
  layout = activateTab(layout, "x", true);
  layout = activateTab(layout, "f");
  assert.equal(groupsOf(layout)[0].chat, "x", "a file shown keeps the chat");
  // Splitting the file off: the chat stays with the tabs it is among.
  const split = splitGroup(layout, groupsOf(layout)[0].id, "row");
  assert.equal(groupOfTab(split, "f").chat, null);
  assert.equal(groupOfTab(split, "x").chat, "x");
  layout = reconcileTabs(layout, ["f", "y"], null);
  assert.equal(groupsOf(layout)[0].chat, null, "a closed chat is forgotten");
});

test("a boundary's range is what moveBoundary allows", () => {
  assert.deepEqual(boundaryRange([0.5, 0.5], 0), [0.1, 0.9]);
  const [min, max] = boundaryRange([0.12, 0.05], 0);
  assert.equal(min, 0.1);
  assert.ok(Math.abs(max - 0.12) < 1e-9);
});

test("chat tabs follow the session list, keeping new and shown ones", () => {
  const tab = (id, name) => ({ id, name, firstMessage: "" });
  const key = (t) => t.id;
  const tabs = [tab("a", "A"), tab("b", "B"), tab("new", "New"), tab("shown", "Shown")];
  const listed = new Map([["a", tab("a", "A renamed")], ["new-other", tab("new-other", "")]]);
  const next = syncChatTabs(tabs, key, listed, new Set(["a", "b", "shown"]), (t) => t.id === "shown", () => false);
  assert.deepEqual(next.map((t) => `${t.id}:${t.name}`), ["a:A renamed", "new:New", "shown:Shown"]);
  // A live tab takes only a copy modified after its own: a cached list may predate its newer title.
  const live = (t) => t.id === "a";
  const dated = [{ ...tabs[0], modified: "2026-01-01T00:00:00Z" }, ...tabs.slice(1)];
  const at = (modified) => new Map([["a", { id: "a", name: "A renamed", firstMessage: "", modified }]]);
  assert.equal(syncChatTabs(dated, key, at("2026-01-01T00:00:00Z"), new Set(), () => true, live), dated);
  assert.equal(syncChatTabs(dated, key, at("2026-01-02T00:00:00Z"), new Set(), () => true, live)[0].name, "A renamed");
  // Nothing to change: the same array.
  assert.equal(syncChatTabs(next, key, new Map(next.map((t) => [t.id, t])), new Set(), () => false, () => false), next);
});

test("a stored layout comes back only when valid, sizes normalized, and new ids never take its ones", async () => {
  // A fresh module, as on a page load: its id counter starts below the stored ids.
  const fresh = await import("./tab-groups.ts?fresh=restore");
  const group = (id, tabs) => ({ kind: "group", id, tabs, active: tabs[0] });
  const stored = { kind: "split", id: "s2", dir: "row", children: [group("g0", ["a"]), group("g1", ["b", "c"])], sizes: [1, 3] };
  const layout = fresh.restoredLayout(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(layout.sizes, [0.25, 0.75]);
  const split = fresh.splitGroup(layout, "g1", "column");
  const ids = [];
  const visit = (node) => { ids.push(node.id); if (node.kind === "split") node.children.forEach(visit); };
  visit(split);
  assert.equal(new Set(ids).size, ids.length, `ids stay unique: ${ids}`);
  for (const bad of [null, 3, group("g0", [1]),
    { ...stored, children: [stored.children[0]], sizes: [1] },
    { ...stored, sizes: [0.5, Number.NaN] },
    { ...stored, dir: "diagonal" },
    { ...stored, children: [group("g0", ["a"]), group("g0", ["b"])] },
    { ...stored, children: [group("g0", ["a"]), group("g1", ["a"])] }]) {
    assert.equal(fresh.restoredLayout(bad), null, JSON.stringify(bad));
  }
});
