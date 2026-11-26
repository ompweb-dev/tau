"use client";

import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { boundaryRange, groupsOf, moveBoundary, type TabGroup, type TabLayout, type TabSplit } from "@/lib/tab-groups";

interface Rect { x: number; y: number; w: number; h: number }
interface Sash { split: TabSplit; index: number; rect: Rect; at: number }

/** Each group's rectangle and each boundary, as fractions of the whole area. */
function place(node: TabLayout, rect: Rect, groups: Map<string, Rect>, sashes: Sash[]) {
  if (node.kind === "group") { groups.set(node.id, rect); return; }
  let offset = 0;
  node.children.forEach((child, i) => {
    const share = node.sizes[i];
    const childRect = node.dir === "row"
      ? { x: rect.x + offset * rect.w, y: rect.y, w: share * rect.w, h: rect.h }
      : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: share * rect.h };
    place(child, childRect, groups, sashes);
    offset += share;
    if (i < node.children.length - 1) sashes.push({ split: node, index: i, rect, at: offset });
  });
}

const percent = (n: number) => `${n * 100}%`;

/** A view a group shows (a chat, a file), placed over its group's area below the strip. */
export interface TabLayer {
  key: string;
  groupId: string;
  node: ReactNode;
}

/**
 * The groups of a tab layout. Every group is a sibling positioned over its
 * share of the area, and so is every view the groups show (`layers`, keyed by
 * what they show, not by group): a split, a resize or a tab moved to another
 * group repositions a view and never remounts it.
 * A group with tabs has its strip (`renderGroup`), `--tab-strip-height` tall,
 * above its views.
 * With `single`, only the focused group shows, over the whole area (phones).
 */
export function TabLayoutView({ layout, focusedGroupId, single, renderGroup, layers, onResize, resizeLabel }: {
  layout: TabLayout;
  focusedGroupId: string;
  single: boolean;
  renderGroup: (group: TabGroup) => ReactNode;
  layers: TabLayer[];
  onResize: (splitId: string, sizes: number[]) => void;
  resizeLabel: string;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  // The pointer of the drag under way: one drag at a time, other pointers ignored.
  const dragPointerRef = useRef<number | null>(null);
  const groupRects = new Map<string, Rect>();
  const sashes: Sash[] = [];
  place(layout, { x: 0, y: 0, w: 1, h: 1 }, groupRects, sashes);
  const groups = groupsOf(layout);
  const rectOf = (group: TabGroup) => single ? { x: 0, y: 0, w: 1, h: 1 } : groupRects.get(group.id)!;
  const hiddenGroup = (group: TabGroup) => single && group.id !== focusedGroupId;

  const startDrag = (event: PointerEvent<HTMLDivElement>, sash: Sash) => {
    const area = areaRef.current?.getBoundingClientRect();
    if (!area || event.button !== 0 || dragPointerRef.current !== null) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    dragPointerRef.current = pointerId;
    const row = sash.split.dir === "row";
    const splitPixels = row ? sash.rect.w * area.width : sash.rect.h * area.height;
    const start = row ? event.clientX : event.clientY;
    const sizes = sash.split.sizes;
    const target = event.currentTarget;
    target.setPointerCapture(pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const delta = ((row ? moveEvent.clientX : moveEvent.clientY) - start) / splitPixels;
      onResize(sash.split.id, moveBoundary(sizes, sash.index, delta));
    };
    const end = (endEvent: globalThis.PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      dragPointerRef.current = null;
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) target.removeEventListener(type, end);
      target.removeEventListener("pointermove", move);
    };
    target.addEventListener("pointermove", move);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) target.addEventListener(type, end);
  };

  const keyResize = (event: KeyboardEvent<HTMLDivElement>, sash: Sash) => {
    const row = sash.split.dir === "row";
    const step = event.key === (row ? "ArrowLeft" : "ArrowUp") ? -0.05 : event.key === (row ? "ArrowRight" : "ArrowDown") ? 0.05 : 0;
    if (!step) return;
    event.preventDefault();
    onResize(sash.split.id, moveBoundary(sash.split.sizes, sash.index, step));
  };

  return (
    <div ref={areaRef} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
      {groups.map((group) => {
        const rect = rectOf(group);
        const hidden = hiddenGroup(group);
        return (
          <div
            key={group.id}
            data-group-id={group.id}
            style={{ position: "absolute", left: percent(rect.x), top: percent(rect.y), width: percent(rect.w), height: percent(rect.h), display: hidden ? "none" : "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}
          >
            {renderGroup(group)}
          </div>
        );
      })}
      {layers.map((layer) => {
        const group = groups.find((candidate) => candidate.id === layer.groupId);
        if (!group) return null;
        const rect = rectOf(group);
        const strip = group.tabs.length > 0 ? "var(--tab-strip-height)" : "0px";
        return (
          <div
            key={layer.key}
            data-layer-group={group.id}
            style={{ position: "absolute", left: percent(rect.x), top: `calc(${percent(rect.y)} + ${strip})`, width: percent(rect.w), height: `calc(${percent(rect.h)} - ${strip})`, display: hiddenGroup(group) ? "none" : "block", overflow: "hidden" }}
          >
            {layer.node}
          </div>
        );
      })}
      {!single && sashes.map((sash) => {
        const row = sash.split.dir === "row";
        // Within the split, as aria-valuenow: the panes before the pair plus each side's floor.
        const before = sash.at - sash.split.sizes[sash.index];
        const [min, max] = boundaryRange(sash.split.sizes, sash.index);
        return (
          <div
            key={`${sash.split.id}:${sash.index}`}
            role="separator"
            aria-orientation={row ? "vertical" : "horizontal"}
            aria-label={resizeLabel}
            aria-valuemin={Math.round((before + min) * 100)}
            aria-valuemax={Math.round((before + max) * 100)}
            aria-valuenow={Math.round(sash.at * 100)}
            tabIndex={0}
            className="tab-group-sash ui-focus-ring"
            onPointerDown={(event) => startDrag(event, sash)}
            onKeyDown={(event) => keyResize(event, sash)}
            style={row
              ? { position: "absolute", left: `calc(${percent(sash.rect.x + sash.at * sash.rect.w)} - 3px)`, top: percent(sash.rect.y), width: 7, height: percent(sash.rect.h), cursor: "col-resize", zIndex: 2, touchAction: "none" }
              : { position: "absolute", top: `calc(${percent(sash.rect.y + sash.at * sash.rect.h)} - 3px)`, left: percent(sash.rect.x), height: 7, width: percent(sash.rect.w), cursor: "row-resize", zIndex: 2, touchAction: "none" }}
          >
            <span aria-hidden="true" className="tab-group-sash-line" style={row
              ? { position: "absolute", left: 3, top: 0, bottom: 0, width: 1 }
              : { position: "absolute", top: 3, left: 0, right: 0, height: 1 }} />
          </div>
        );
      })}
    </div>
  );
}
