// Editor-group layout of the main tab strip: a tree of splits whose leaves are
// tab groups. Every open tab lives in exactly one group. Pure functions only:
// AppShell keeps the tree in state and the views read it.

export interface TabGroup {
  kind: "group";
  id: string;
  /** Tab ids in strip order. */
  tabs: string[];
  /** The tab the group shows (the focused group's is the app's shown tab). */
  active: string | null;
}

export interface TabSplit {
  kind: "split";
  id: string;
  /** "row": children side by side; "column": stacked. */
  dir: "row" | "column";
  children: TabLayout[];
  /** Each child's share of the split, summing to 1. */
  sizes: number[];
}

export type TabLayout = TabGroup | TabSplit;

/** Smallest share a resize leaves a child. */
export const MIN_SHARE = 0.1;

let nextId = 0;
const newId = (prefix: string) => `${prefix}${++nextId}`;

export const initialLayout = (): TabLayout => ({ kind: "group", id: "g0", tabs: [], active: null });

export function groupsOf(layout: TabLayout): TabGroup[] {
  return layout.kind === "group" ? [layout] : layout.children.flatMap(groupsOf);
}

export function groupOfTab(layout: TabLayout, tabId: string): TabGroup | undefined {
  return groupsOf(layout).find((group) => group.tabs.includes(tabId));
}

/** The split with these children; the same object when none changed. */
const withChildren = (split: TabSplit, children: TabLayout[]): TabSplit =>
  children.every((child, i) => child === split.children[i]) ? split : { ...split, children };

function mapGroups(layout: TabLayout, fn: (group: TabGroup) => TabGroup): TabLayout {
  return layout.kind === "group" ? fn(layout) : withChildren(layout, layout.children.map((child) => mapGroups(child, fn)));
}

/** Drops empty groups (the last one stays) and splits left with one child. */
function prune(layout: TabLayout): TabLayout | null {
  if (layout.kind === "group") return layout.tabs.length > 0 ? layout : null;
  const kept: TabLayout[] = [];
  const sizes: number[] = [];
  layout.children.forEach((child, i) => {
    const pruned = prune(child);
    if (pruned) { kept.push(pruned); sizes.push(layout.sizes[i]); }
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  const unchanged = kept.length === layout.children.length && kept.every((child, i) => child === layout.children[i]);
  return unchanged ? layout : { ...layout, children: kept, sizes: sizes.map((size) => size / total) };
}

function pruned(layout: TabLayout): TabLayout {
  return prune(layout) ?? groupsOf(layout)[0] ?? initialLayout();
}

function withoutTab(group: TabGroup, tabId: string): TabGroup {
  const index = group.tabs.indexOf(tabId);
  if (index < 0) return group;
  const tabs = group.tabs.filter((id) => id !== tabId);
  const active = group.active === tabId ? tabs[Math.min(index, tabs.length - 1)] ?? null : group.active;
  return { ...group, tabs, active };
}

/**
 * Keeps the layout in step with the open tabs: closed ones leave their group
 * (its neighbour becomes its shown tab), new ones join `targetGroupId`.
 */
export function reconcileTabs(layout: TabLayout, ids: readonly string[], targetGroupId: string | null): TabLayout {
  const open = new Set(ids);
  const groups = groupsOf(layout);
  const placed = new Set(groups.flatMap((group) => group.tabs));
  const added = ids.filter((id) => !placed.has(id));
  const target = groups.find((group) => group.id === targetGroupId) ?? groups[0];
  return pruned(mapGroups(layout, (group) => {
    let result = group;
    for (const id of group.tabs) if (!open.has(id)) result = withoutTab(result, id);
    if (group.id === target.id && added.length > 0) result = { ...result, tabs: [...result.tabs, ...added] };
    return result;
  }));
}

/** Makes `tabId` its group's shown tab. */
export function activateTab(layout: TabLayout, tabId: string): TabLayout {
  return mapGroups(layout, (group) => group.tabs.includes(tabId) && group.active !== tabId ? { ...group, active: tabId } : group);
}

/** Moves a tab before `beforeId` in `groupId` (at the end without one); it becomes that group's shown tab. */
export function moveTab(layout: TabLayout, tabId: string, groupId: string, beforeId: string | null): TabLayout {
  if (!groupOfTab(layout, tabId) || !groupsOf(layout).some((group) => group.id === groupId) || beforeId === tabId) return layout;
  const next = mapGroups(layout, (group) => {
    const result = group.tabs.includes(tabId) ? withoutTab(group, tabId) : group;
    if (group.id !== groupId) return result;
    const tabs = [...result.tabs];
    const index = beforeId ? tabs.indexOf(beforeId) : -1;
    tabs.splice(index < 0 ? tabs.length : index, 0, tabId);
    return { ...result, tabs, active: tabId };
  });
  return pruned(next);
}

/**
 * Splits a group: its shown tab moves after the others (`dir` "row": to the
 * right; "column": below). The shown tab keeps the group's id, so what it
 * shows stays mounted; the other tabs form the new group. Needs two tabs or more.
 */
export function splitGroup(layout: TabLayout, groupId: string, dir: TabSplit["dir"]): TabLayout {
  const source = groupsOf(layout).find((group) => group.id === groupId);
  if (!source?.active || source.tabs.length < 2) return layout;
  const moved: TabGroup = { ...source, tabs: [source.active] };
  const rest: TabGroup = { ...withoutTab(source, source.active), id: newId("g") };
  const insert = (node: TabLayout): TabLayout => {
    if (node.kind === "group") {
      return node.id === groupId ? { kind: "split", id: newId("s"), dir, children: [rest, moved], sizes: [0.5, 0.5] } : node;
    }
    const index = node.children.findIndex((child) => child.kind === "group" && child.id === groupId);
    if (index >= 0 && node.dir === dir) {
      // Same direction: the new group takes half of the source's share.
      const children = [...node.children];
      const sizes = [...node.sizes];
      children.splice(index, 1, rest, moved);
      sizes.splice(index, 1, node.sizes[index] / 2, node.sizes[index] / 2);
      return { ...node, children, sizes };
    }
    return withChildren(node, node.children.map(insert));
  };
  return insert(layout);
}

/** New shares (from moveBoundary) for a split's children. */
export function resizeSplit(layout: TabLayout, splitId: string, sizes: number[]): TabLayout {
  if (layout.kind === "group") return layout;
  if (layout.id === splitId) return sizes.length === layout.children.length && sizes.every(Number.isFinite) ? { ...layout, sizes } : layout;
  return withChildren(layout, layout.children.map((child) => resizeSplit(child, splitId, sizes)));
}

/**
 * Moves the boundary after child `index` of a split by `delta` (a share),
 * leaving either side at least MIN_SHARE. A side already narrower never
 * shrinks, except toward the middle of a pair narrower than two minimums.
 * The floors come from `sizes`: a drag passes its starting sizes.
 */
export function moveBoundary(sizes: readonly number[], index: number, delta: number): number[] {
  const pair = sizes[index] + sizes[index + 1];
  const floor = (size: number) => size < MIN_SHARE ? Math.min(size, pair / 2) : MIN_SHARE;
  const left = Math.min(pair - floor(sizes[index + 1]), Math.max(floor(sizes[index]), sizes[index] + delta));
  const next = [...sizes];
  next[index] = left;
  next[index + 1] = pair - left;
  return next;
}

/** The React keys of the chats the groups show, and what they were worked out for. */
export interface ChatMounts {
  selected: string | null;
  sessionKey: number;
  keys: Record<string, string>;
}

/**
 * Mount keys after a change of the selected chat or of AppShell's sessionKey.
 * A chat keeps its key while it turns from the selected chat into another
 * group's and back, so focusing a group remounts nothing. A sessionKey bump
 * remounts the selected chat, unless the bump comes with switching to a chat
 * a group already shows (`shownIds`). The selected chat changing identity
 * without a bump (a new chat's first send, an Edit move) keeps its mount,
 * unless the new identity already has a key of its own (no current path).
 * Only open chats (`openIds`) keep a key.
 */
export function nextChatMounts(prev: ChatMounts, selected: string | null, sessionKey: number, openIds: readonly string[], shownIds: ReadonlySet<string>): ChatMounts {
  if (prev.selected === selected && prev.sessionKey === sessionKey) return prev;
  const keys = Object.fromEntries(Object.entries(prev.keys).filter(([id]) => openIds.includes(id)));
  if (selected) {
    if (prev.sessionKey === sessionKey) {
      // A chat with a key keeps it. Otherwise it carries the previous identity's
      // key, read before the filter: that tab may be gone already.
      keys[selected] ??= prev.selected ? prev.keys[prev.selected] ?? prev.selected : `${selected}~${sessionKey}`;
    } else if (prev.selected === selected || !shownIds.has(selected)) {
      keys[selected] = `${selected}~${sessionKey}`;
    }
  }
  return { selected, sessionKey, keys };
}
