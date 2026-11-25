"use client";

import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { groupsOf, moveBoundary, type TabGroup, type TabLayout, type TabSplit } from "@/lib/tab-groups";

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

/**
 * The groups of a tab layout. Every group is a sibling positioned over its
 * share of the area, so a split or resize never remounts a group's content.
 * With `single`, only the focused group shows, over the whole area (phones).
 */
export function TabLayoutView({ layout, focusedGroupId, single, renderGroup, onResize, resizeLabel }: {
  layout: TabLayout;
  focusedGroupId: string;
  single: boolean;
  renderGroup: (group: TabGroup) => ReactNode;
  onResize: (splitId: string, sizes: number[]) => void;
  resizeLabel: string;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const groupRects = new Map<string, Rect>();
  const sashes: Sash[] = [];
  place(layout, { x: 0, y: 0, w: 1, h: 1 }, groupRects, sashes);

  const startDrag = (event: PointerEvent<HTMLDivElement>, sash: Sash) => {
    const area = areaRef.current?.getBoundingClientRect();
    if (!area || event.button !== 0) return;
    event.preventDefault();
    const row = sash.split.dir === "row";
    const splitPixels = row ? sash.rect.w * area.width : sash.rect.h * area.height;
    const start = row ? event.clientX : event.clientY;
    const sizes = sash.split.sizes;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const delta = ((row ? moveEvent.clientX : moveEvent.clientY) - start) / splitPixels;
      onResize(sash.split.id, moveBoundary(sizes, sash.index, delta));
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
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
      {groupsOf(layout).map((group) => {
        const rect = single ? { x: 0, y: 0, w: 1, h: 1 } : groupRects.get(group.id)!;
        const hidden = single && group.id !== focusedGroupId;
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
      {!single && sashes.map((sash) => {
        const row = sash.split.dir === "row";
        return (
          <div
            key={`${sash.split.id}:${sash.index}`}
            role="separator"
            aria-orientation={row ? "vertical" : "horizontal"}
            aria-label={resizeLabel}
            aria-valuemin={0}
            aria-valuemax={100}
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
