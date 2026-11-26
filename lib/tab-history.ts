/** A tab group's back/forward history: the tabs it showed before (and after, once stepped back from) its current one. */
export interface TabHistory {
  back: readonly string[];
  forward: readonly string[];
  current: string | null;
}

export const EMPTY_TAB_HISTORY: TabHistory = { back: [], forward: [], current: null };

/** Kept per direction; older entries drop off. */
const LIMIT = 50;

/** The group now shows `id`: what it showed goes back, and the forward side is gone (as in a browser). */
export function visit(history: TabHistory, id: string | null): TabHistory {
  if (id === history.current) return history;
  if (id === null) return { ...history, current: null };
  const back = history.current === null ? history.back : [...history.back, history.current].slice(-LIMIT);
  return { back, forward: [], current: id };
}

/** The tab one step back (-1) or forward (1) that is still open in the group, or null. */
export function stepTarget(history: TabHistory, dir: -1 | 1, open: ReadonlySet<string>): string | null {
  const side = dir < 0 ? history.back : history.forward;
  for (let index = side.length - 1; index >= 0; index -= 1) {
    if (open.has(side[index]) && side[index] !== history.current) return side[index];
  }
  return null;
}

/**
 * The history once the group stepped to `stepTarget`'s answer: the current tab goes to the other side, and so do
 * the tabs passed over that are still in `kept` (open, but not a target now, say a chat whose host is offline);
 * the others (closed) drop out.
 */
export function step(history: TabHistory, dir: -1 | 1, open: ReadonlySet<string>, kept: ReadonlySet<string> = open): TabHistory {
  const target = stepTarget(history, dir, open);
  if (target === null) return history;
  const from = dir < 0 ? history.back : history.forward;
  const to = dir < 0 ? history.forward : history.back;
  const index = from.lastIndexOf(target);
  const rest = from.slice(0, index);
  const skipped = from.slice(index + 1).filter((id) => kept.has(id) && id !== history.current).reverse();
  const passed = [...to, ...(history.current === null ? [] : [history.current]), ...skipped].slice(-LIMIT);
  return dir < 0 ? { back: rest, forward: passed, current: target } : { back: passed, forward: rest, current: target };
}
