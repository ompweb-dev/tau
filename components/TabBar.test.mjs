import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");

const { TabBar } = await import("./TabBar.tsx");

beforeEach(() => {
  globalThis.CSS ??= { escape: (value) => value };
});

afterEach(cleanup);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

test("tabs support roving arrows, Home/End, and keyboard close", async () => {
  const selected = [];
  const closed = [];
  const tabs = [
    { id: "alpha", label: "alpha.ts", title: "/workspace/alpha.ts", icon: null },
    { id: "beta", label: "beta.ts", title: "/workspace/beta.ts", icon: null },
  ];

  render(React.createElement(TabBar, {
    tabs,
    activeTabId: "alpha",
    onSelectTab: (id) => selected.push(id),
    onCloseTab: (id) => closed.push(id),
    explorerSelected: true,
    onSelectExplorer: () => selected.push("explorer"),
    onSelectSearch: () => selected.push("search"),
    gitSelected: false,
    onSelectGit: () => selected.push("git"),
    onSelectNotifications: () => selected.push("notifications"),
    worktreesSelected: false,
    onSelectWorktrees: () => selected.push("worktrees"),
  }));

  // Notifications is the first pinned tab, so Home lands there.
  const notifications = screen.getByRole("tab", { name: "Notifications" });

  const explorer = screen.getByRole("tab", { name: "Files" });
  const search = screen.getByRole("tab", { name: "Search" });
  const alpha = screen.getByRole("tab", { name: "/workspace/alpha.ts" });
  const beta = screen.getByRole("tab", { name: "/workspace/beta.ts" });
  assert.equal(alpha.tabIndex, 0);
  assert.equal(screen.getByRole("button", { name: "Close alpha.ts" }).tabIndex, 0);

  alpha.focus();
  fireEvent.keyDown(alpha, { key: "ArrowRight" });
  await nextFrame();
  assert.equal(document.activeElement, beta);
  assert.deepEqual(selected, ["beta"]);

  fireEvent.keyDown(beta, { key: "Home" });
  await nextFrame();
  assert.equal(document.activeElement, notifications);
  assert.deepEqual(selected, ["beta", "notifications"]);

  fireEvent.keyDown(notifications, { key: "ArrowRight" });
  await nextFrame();
  assert.equal(document.activeElement, explorer);
  assert.deepEqual(selected, ["beta", "notifications", "explorer"]);

  fireEvent.keyDown(explorer, { key: "ArrowRight" });
  await nextFrame();
  assert.equal(document.activeElement, search);
  assert.deepEqual(selected, ["beta", "notifications", "explorer", "search"]);

  fireEvent.keyDown(search, { key: "End" });
  await nextFrame();
  assert.equal(document.activeElement, beta);
  assert.deepEqual(selected, ["beta", "notifications", "explorer", "search", "beta"]);

  fireEvent.keyDown(beta, { key: "Delete" });
  assert.deepEqual(closed, ["beta"]);

  fireEvent.keyDown(alpha, { key: "ArrowLeft" });
  await nextFrame();
  assert.equal(document.activeElement, screen.getByRole("tab", { name: "Worktrees" }));
  assert.deepEqual(selected, ["beta", "notifications", "explorer", "search", "beta", "worktrees"]);
});

test("a tab that is not closable has no close button and ignores Delete", () => {
  const closed = [];
  render(React.createElement(TabBar, {
    tabs: [{ id: "chat:new", label: "New session", title: "New session", icon: null, closable: false }],
    activeTabId: "chat:new",
    onCloseTab: (id) => closed.push(id),
  }));
  const tab = screen.getByRole("tab", { name: "New session" });
  assert.equal(screen.queryByRole("button", { name: "Close New session" }), null);
  fireEvent.keyDown(tab, { key: "Delete" });
  assert.deepEqual(closed, []);
});

test("closing a tab from the keyboard moves focus to its neighbour", async () => {
  const closed = [];
  const tabs = [
    { id: "a", label: "a.ts", title: "a.ts", icon: null },
    { id: "b", label: "b.ts", title: "b.ts", icon: null },
    { id: "c", label: "c.ts", title: "c.ts", icon: null },
  ];
  const view = render(React.createElement(TabBar, { tabs, activeTabId: "a", manualActivation: true, onCloseTab: (id) => closed.push(id) }));
  const b = screen.getByRole("tab", { name: "b.ts" });
  b.focus();
  fireEvent.keyDown(b, { key: "Delete" });
  view.rerender(React.createElement(TabBar, { tabs: tabs.filter((tab) => tab.id !== "b"), activeTabId: "a", manualActivation: true, onCloseTab: (id) => closed.push(id) }));
  await nextFrame();
  assert.deepEqual(closed, ["b"]);
  assert.equal(document.activeElement, screen.getByRole("tab", { name: "c.ts" }));
});

test("Alt+Shift+arrows move the focused tab along its strip and to another strip", () => {
  const drops = [];
  const moves = [];
  const tabs = ["a", "b", "c"].map((id) => ({ id, label: id, title: id, icon: null }));
  render(React.createElement(TabBar, { tabs, activeTabId: "b", onSelectTab() {}, onDropTab: (...args) => drops.push(args), onMoveTabToGroup: (...args) => moves.push(args) }));
  const tab = screen.getByRole("tab", { name: "b" });
  fireEvent.keyDown(tab, { key: "ArrowLeft", altKey: true, shiftKey: true });
  fireEvent.keyDown(tab, { key: "ArrowRight", altKey: true, shiftKey: true });
  fireEvent.keyDown(tab, { key: "ArrowDown", altKey: true, shiftKey: true });
  assert.deepEqual(drops, [["b", "a"], ["b", null]]);
  assert.deepEqual(moves, [["b", 1]]);
});

test("the strip marks the ends that have tabs scrolled out of view", () => {
  const tabs = ["a", "b", "c"].map((id) => ({ id, label: `${id}.ts`, title: id, icon: null }));
  render(React.createElement(TabBar, { tabs, activeTabId: "a", onSelectTab() {}, onCloseTab() {}, ariaLabel: "Open tabs" }));
  const list = screen.getByRole("tablist", { name: "Open tabs" });
  Object.defineProperty(list, "clientWidth", { configurable: true, value: 200 });
  Object.defineProperty(list, "scrollWidth", { configurable: true, value: 500 });
  const at = (left) => { list.scrollLeft = left; fireEvent.scroll(list); return list.getAttribute("data-overflow"); };
  assert.equal(at(0), "end");
  assert.equal(at(100), "both");
  assert.equal(at(300), "start");
  Object.defineProperty(list, "scrollWidth", { configurable: true, value: 200 });
  assert.equal(at(0), null, "a strip that fits has no cue");
});

test("a tab's context menu opens on right click and from the keyboard, and runs the chosen item", async () => {
  const chosen = [];
  const tabs = [
    { id: "alpha", label: "alpha.ts", title: "/workspace/alpha.ts", icon: null },
    { id: "beta", label: "beta.ts", title: "/workspace/beta.ts", icon: null },
  ];
  render(React.createElement(TabBar, {
    tabs,
    activeTabId: "alpha",
    onDropTab: () => {},
    tabMenu: (id) => [
      { label: "Split right", onSelect: () => chosen.push(`split:${id}`) },
      { label: "Close others", disabled: true, onSelect: () => chosen.push("never") },
    ],
    trailing: React.createElement("button", { type: "button", "aria-label": "New" }, "+"),
  }));
  const beta = screen.getByRole("tab", { name: "/workspace/beta.ts" });
  assert.equal(beta.getAttribute("aria-haspopup"), "menu");
  // The trailing control sits after the tablist, not inside it.
  const plus = screen.getByRole("button", { name: "New" });
  assert.equal(plus.closest('[role="tablist"]'), null);

  fireEvent.contextMenu(beta, { clientX: 40, clientY: 30 });
  assert.equal(screen.getByRole("menuitem", { name: "Close others" }).disabled, true);
  fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
  assert.deepEqual(chosen, ["split:beta"]);
  assert.equal(screen.queryByRole("menuitem"), null, "choosing an item closes the menu");

  const alpha = screen.getByRole("tab", { name: "/workspace/alpha.ts" });
  fireEvent.keyDown(alpha, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
  assert.deepEqual(chosen, ["split:beta", "split:alpha"]);
});
