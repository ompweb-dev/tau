"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Activity, Bell, Folder, GitBranch, GitFork, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { SidebarPortalMenu } from "./SessionSidebar-chrome";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  hostId: string;
  sourceSessionId?: string | null;
  /** Original workspace context; selecting another conversation must not rebase this tab. */
  sourceCwd: string | null;
  /** A line to scroll to and mark; `seq` tells a repeat of the same line apart. */
  revealLine?: { line: number; seq: number };
}

/** An entry of a strip tab's context menu. */
export interface TabMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** A tab of the strip after the pinned ones: an open chat or file. */
export interface StripTab {
  id: string;
  label: string;
  /** Full name: the tooltip and the accessible name. */
  title: string;
  icon: ReactNode;
  /** False hides the close button (the transient New chat tab). */
  closable?: boolean;
  /** The panel the tab shows (aria-controls). */
  panelId?: string;
}

interface Props {
  tabs?: StripTab[];
  activeTabId?: string;
  onSelectTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  /** The tablist's accessible name. */
  ariaLabel?: string;
  /** Arrows only move focus; Enter or Space shows the tab (for tabs that are costly to show). */
  manualActivation?: boolean;
  /** Tabs can be dragged, within this strip and between strips: a drop lands before `beforeId` (at the end without one). */
  onDropTab?: (tabId: string, beforeId: string | null) => void;
  /** Alt+Shift+ArrowUp/ArrowDown move the focused tab to the previous (-1) or next (1) strip. */
  onMoveTabToGroup?: (tabId: string, step: -1 | 1) => void;
  /** A tab's context menu (right click, the Menu key or Shift+F10). */
  tabMenu?: (tabId: string) => TabMenuItem[];
  /** Right after the last tab, outside the tablist (the strip's "+"); the strip then fits its tabs. */
  trailing?: ReactNode;
  /** Pinned Explorer tab rendered after Notifications, before the file tabs (right-panel tab redesign). */
  explorerSelected?: boolean;
  onSelectExplorer?: () => void;
  /** Changed-file count badge on the Explorer tab. */
  explorerBadge?: number;
  /** Pinned Search tab rendered after Files. */
  searchSelected?: boolean;
  onSelectSearch?: () => void;
  /** Pinned Git changes tab rendered after Search. */
  gitSelected?: boolean;
  onSelectGit?: () => void;
  /** Changed-file count badge on the Git tab. */
  gitBadge?: number;
  /** Pinned Notifications tab rendered first. */
  notificationsSelected?: boolean;
  onSelectNotifications?: () => void;
  /** Unread-notification count badge on the Notifications tab. */
  notificationsBadge?: number;
  /** Pinned Worktrees tab rendered after Git. */
  worktreesSelected?: boolean;
  onSelectWorktrees?: () => void;
  /** Pinned Connection tab rendered last (connection diagnostics on). */
  connectionSelected?: boolean;
  onSelectConnection?: () => void;
}
/** Width of the fade at a strip end with tabs scrolled out of view (globals.css `.tabbar-scroll[data-overflow]`). */
const TAB_FADE_PX = 28;
const badgeStyle = (color: string) => ({
  display: "inline-flex",
  alignItems: "center",
  minWidth: 16,
  height: 15,
  padding: "0 4px",
  borderRadius: 8,
  background: `color-mix(in srgb, ${color} 18%, transparent)`,
  color,
  fontSize: 10,
  fontWeight: 700,
});

/** Notifications / Files / Search / Git: fixed tabs before the file tabs. */
function PinnedTab({ id, panelId, label, title, icon, selected, badge, badgeColor, onSelect, onKeyDown }: {
  id: string;
  panelId: string;
  label: string;
  title: string;
  icon: ReactNode;
  selected: boolean;
  badge: number;
  badgeColor: string;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, id: string) => void;
}) {
  return (
    <div
      data-tab-id={id}
      className="tabbar-tab ui-focus-ring"
      onClick={onSelect}
      role="tab"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      aria-label={label}
      aria-controls={panelId}
      title={title}
      onKeyDown={(event) => onKeyDown(event, id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: "var(--tab-height)",
        paddingLeft: 12,
        paddingRight: 10,
        borderRight: "1px solid var(--border)",
        background: selected ? "var(--bg)" : "var(--bg-panel)",
        cursor: "pointer",
        fontSize: "var(--text-sm)",
        color: selected ? "var(--text)" : "var(--text-muted)",
        whiteSpace: "nowrap",
        flexShrink: 0,
        userSelect: "none",
        position: "relative",
        transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
      }}
    >
      {selected && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 2,
            background: "var(--accent)",
            borderTopLeftRadius: "var(--radius-control)",
            borderTopRightRadius: "var(--radius-control)",
          }}
        />
      )}
      <span style={{ flexShrink: 0, opacity: selected ? 1 : 0.7, display: "flex", alignItems: "center", color: selected ? "var(--accent)" : undefined }}>
        {icon}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: selected ? 500 : 400 }}>
        {label}
      </span>
      {badge > 0 && (
        <span aria-hidden="true" style={badgeStyle(badgeColor)}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </div>
  );
}

/** Drag data type of a strip tab being moved. */
const TAB_DRAG_TYPE = "application/x-tau-tab";

export function TabBar({ tabs = [], activeTabId = "", onSelectTab, onCloseTab, ariaLabel, manualActivation = false, onDropTab, onMoveTabToGroup, tabMenu, trailing, explorerSelected = false, onSelectExplorer, explorerBadge = 0, searchSelected = false, onSelectSearch, gitSelected = false, onSelectGit, gitBadge = 0, notificationsSelected = false, onSelectNotifications, notificationsBadge = 0, worktreesSelected = false, onSelectWorktrees, connectionSelected = false, onSelectConnection }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The tab whose context menu is open, and where (null: below the tab, as from the keyboard).
  const [menu, setMenu] = useState<{ tabId: string; point: { x: number; y: number } | null } | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const openMenu = (tabId: string, element: HTMLElement, point: { x: number; y: number } | null) => {
    menuAnchorRef.current = element;
    setMenu({ tabId, point });
  };
  const closeMenu = useCallback(() => setMenu(null), []);
  const orderedTabIds = [
    ...(onSelectNotifications ? ["notifications"] : []),
    ...(onSelectExplorer ? ["explorer"] : []),
    ...(onSelectSearch ? ["search"] : []),
    ...(onSelectGit ? ["git"] : []),
    ...(onSelectWorktrees ? ["worktrees"] : []),
    ...(onSelectConnection ? ["connection"] : []),
    ...tabs.map((tab) => tab.id),
  ];

  const selectTabById = (id: string) => {
    if (id === "explorer") onSelectExplorer?.();
    else if (id === "search") onSelectSearch?.();
    else if (id === "git") onSelectGit?.();
    else if (id === "notifications") onSelectNotifications?.();
    else if (id === "worktrees") onSelectWorktrees?.();
    else if (id === "connection") onSelectConnection?.();
    else {
      const tab = tabs.find((item) => item.id === id);
      if (tab) onSelectTab?.(tab.id);
    }
  };

  const focusTabById = (id: string) => {
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (tabMenu && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && tabs.some((tab) => tab.id === id)) {
      event.preventDefault();
      openMenu(id, event.currentTarget, null);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTabById(id);
      return;
    }

    const index = orderedTabIds.indexOf(id);
    if (index < 0 || orderedTabIds.length === 0) return;
    // Alt+Shift+arrows move the tab: along the strip (as a drag would), or to another strip.
    if (event.altKey && event.shiftKey && tabs.some((tab) => tab.id === id)) {
      const at = tabs.findIndex((tab) => tab.id === id);
      if (onDropTab && event.key === "ArrowLeft" && at > 0) { event.preventDefault(); onDropTab(id, tabs[at - 1].id); return; }
      if (onDropTab && event.key === "ArrowRight" && at < tabs.length - 1) { event.preventDefault(); onDropTab(id, tabs[at + 2]?.id ?? null); return; }
      if (onMoveTabToGroup && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); onMoveTabToGroup(id, event.key === "ArrowUp" ? -1 : 1); return; }
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % orderedTabIds.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + orderedTabIds.length) % orderedTabIds.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = orderedTabIds.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      const nextId = orderedTabIds[nextIndex];
      if (!manualActivation) selectTabById(nextId);
      focusTabById(nextId);
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && tabs.some((tab) => tab.id === id && tab.closable !== false)) {
      event.preventDefault();
      onCloseTab?.(id);
      // Keep keyboard focus in the strip, on the tab that takes the closed one's place.
      const neighbour = orderedTabIds[index + 1] ?? orderedTabIds[index - 1];
      if (neighbour) focusTabById(neighbour);
    }
  };

  // ponytail: no drop indicator; the tab lands before the one under the pointer.
  const allowTabDrop = (event: DragEvent<HTMLElement>) => {
    if (!onDropTab || !event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  const dropTab = (event: DragEvent<HTMLElement>, beforeId: string | null) => {
    if (!onDropTab) return;
    const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE);
    if (!tabId) return;
    event.preventDefault();
    event.stopPropagation();
    onDropTab(tabId, beforeId);
  };

  // Keeps the active tab in view, clear of the faded ends when it fits between them (scrolling stops at the
  // strip's own ends).
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const revealActive = useCallback(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabIdRef.current)}"]`);
    if (!list || !active) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    const inset = listRect.width >= tabRect.width + 2 * TAB_FADE_PX ? TAB_FADE_PX : 0;
    if (tabRect.left < listRect.left + inset) {
      list.scrollLeft -= listRect.left + inset - tabRect.left;
    } else if (tabRect.right > listRect.right - inset) {
      list.scrollLeft += tabRect.right - (listRect.right - inset);
    }
  }, []);

  // Which ends have tabs scrolled out of view: those ends fade, so tabs there do not look closed.
  const [overflow, setOverflow] = useState<"start" | "end" | "both" | null>(null);
  // Labels change the strip's width as much as tabs coming and going.
  const labels = tabs.map((tab) => tab.label).join("\0");
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setOverflow(start && end ? "both" : start ? "start" : end ? "end" : null);
    };
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    // A strip that narrows (a split, a resized window or panel) brings the active tab back into view.
    let width = list.clientWidth;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (list.clientWidth !== width) { width = list.clientWidth; revealActive(); }
      measure();
    }) : null;
    observer?.observe(list);
    return () => { list.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, [labels, revealActive]);

  // Not on every render, nor on another tab's relabel: a strip the user scrolled stays where it is.
  const activeLabel = tabs.find((tab) => tab.id === activeTabId)?.label;
  const order = tabs.map((tab) => tab.id).join("\0");
  useEffect(revealActive, [activeTabId, activeLabel, order, revealActive]);

  const menuItems = menu && tabMenu ? tabMenu(menu.tabId) : [];
  const list = (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel ?? t("appShell.filePanel")}
      aria-orientation="horizontal"
      className="tabbar-scroll"
      data-overflow={overflow ?? undefined}
      data-group-strip={trailing ? "" : undefined}
      onDragOver={trailing ? undefined : allowTabDrop}
      onDrop={trailing ? undefined : (event) => dropTab(event, null)}
      style={{
        display: "flex",
        minWidth: onDropTab && !trailing ? "100%" : 0,
        background: "var(--bg-panel)",
        // Let a classic horizontal scrollbar take space below the tabs.
        overflowX: "auto",
        flexShrink: trailing ? 1 : 0,
      }}
    >
      {onSelectNotifications && (
        <PinnedTab
          id="notifications"
          panelId="workspace-file-panel-notifications"
          label={t("appShell.notifications")}
          title={notificationsBadge > 0 ? t("appShell.notificationsUnreadCount", { count: notificationsBadge }) : t("appShell.notifications")}
          icon={<Bell size={13} strokeWidth={2} aria-hidden="true" />}
          selected={notificationsSelected}
          badge={notificationsBadge}
          badgeColor="var(--accent)"
          onSelect={onSelectNotifications}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectExplorer && (
        <PinnedTab
          id="explorer"
          panelId="workspace-file-panel-explorer"
          label={t("tabBar.files")}
          title={explorerBadge > 0 ? t("sessionSidebar.explorerChanged", { count: explorerBadge }) : t("tabBar.files")}
          icon={<Folder size={13} strokeWidth={2} aria-hidden="true" />}
          selected={explorerSelected}
          badge={explorerBadge}
          badgeColor="var(--status-modified)"
          onSelect={onSelectExplorer}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectSearch && (
        <PinnedTab
          id="search"
          panelId="workspace-file-panel-search"
          label={t("tabBar.search")}
          title={t("tabBar.search")}
          icon={<Search size={13} strokeWidth={2} aria-hidden="true" />}
          selected={searchSelected}
          badge={0}
          badgeColor="var(--accent)"
          onSelect={onSelectSearch}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectGit && (
        <PinnedTab
          id="git"
          panelId="workspace-file-panel-git"
          label={t("tabBar.git")}
          title={gitBadge > 0 ? t("sessionSidebar.explorerChanged", { count: gitBadge }) : t("tabBar.git")}
          icon={<GitBranch size={13} strokeWidth={2} aria-hidden="true" />}
          selected={gitSelected}
          badge={gitBadge}
          badgeColor="var(--status-modified)"
          onSelect={onSelectGit}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectWorktrees && (
        <PinnedTab
          id="worktrees"
          panelId="workspace-file-panel-worktrees"
          label={t("tabBar.worktrees")}
          title={t("tabBar.worktrees")}
          icon={<GitFork size={13} strokeWidth={2} aria-hidden="true" />}
          selected={worktreesSelected}
          badge={0}
          badgeColor="var(--accent)"
          onSelect={onSelectWorktrees}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {onSelectConnection && (
        <PinnedTab
          id="connection"
          panelId="workspace-file-panel-connection"
          label={t("tabBar.connection")}
          title={t("tabBar.connection")}
          icon={<Activity size={13} strokeWidth={2} aria-hidden="true" />}
          selected={connectionSelected}
          badge={0}
          badgeColor="var(--accent)"
          onSelect={onSelectConnection}
          onKeyDown={handleTabKeyDown}
        />
      )}
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        // With nothing selected, the first tab keeps the tablist reachable by keyboard.
        const focusable = isActive || (index === 0 && !orderedTabIds.includes(activeTabId));
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className="tabbar-tab ui-focus-ring"
            onClick={() => onSelectTab?.(tab.id)}
            role="tab"
            tabIndex={focusable ? 0 : -1}
            aria-selected={isActive}
            aria-label={tab.title}
            aria-controls={tab.panelId}
            draggable={onDropTab ? true : undefined}
            aria-keyshortcuts={onDropTab ? (onMoveTabToGroup ? "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight") : undefined}
            onDragStart={onDropTab ? (event) => {
              event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
              event.dataTransfer.effectAllowed = "move";
            } : undefined}
            onDrop={(event) => dropTab(event, tab.id)}
            onContextMenu={tabMenu ? (event) => { event.preventDefault(); openMenu(tab.id, event.currentTarget, { x: event.clientX, y: event.clientY }); } : undefined}
            aria-haspopup={tabMenu ? "menu" : undefined}
            onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1 || tab.closable === false) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab?.(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: "var(--tab-height)",
              paddingLeft: 12,
              paddingRight: tab.closable === false ? 12 : 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: "var(--text-sm)",
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              position: "relative",
              transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
            }}
          >
            {isActive && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 2,
                  background: "var(--accent)",
                  borderTopLeftRadius: "var(--radius-control)",
                  borderTopRightRadius: "var(--radius-control)",
                }}
              />
            )}
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.icon}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.title}
            >
              {tab.label}
            </span>
            {tab.closable !== false && <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCloseTab?.(tab.id); }}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={(event) => event.stopPropagation()}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "var(--icon-control-size-compact)", height: "var(--icon-control-size-compact)",
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: `background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)`,
              }}
              title={t("tabBar.close")}
              aria-label={t("tabBar.closeTab", { label: tab.label })}
            >
              <X size={11} strokeWidth={2} aria-hidden="true" />
            </button>}
          </div>
        );
      })}
    </div>
  );
  return (
    <>
      {trailing ? (
        // The whole strip past the tabs takes a dropped tab at the end.
        <div onDragOver={allowTabDrop} onDrop={(event) => dropTab(event, null)} style={{ display: "flex", alignItems: "center", minWidth: "100%" }}>
          {list}
          {trailing}
        </div>
      ) : list}
      {tabMenu && (
        <SidebarPortalMenu anchor={menuAnchorRef} open={menu !== null} onClose={closeMenu} placement="below" align="start" point={menu?.point ?? null} minWidth={160}>
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="sidebar-menu-item"
              disabled={item.disabled}
              style={{ padding: "6px 9px", borderRadius: 6, color: item.disabled ? "var(--text-dim)" : "var(--text-muted)", fontSize: 12, opacity: item.disabled ? 0.55 : 1, cursor: item.disabled ? "default" : "pointer" }}
              onClick={() => {
                const tabId = menu?.tabId ?? "";
                item.onSelect();
                // Runs before the menu's own focus restore, which then leaves this focus alone.
                requestAnimationFrame(() => {
                  if (menuAnchorRef.current?.isConnected) return;
                  // Split off: the tab, in its new strip. Closed: this strip's shown tab, or the first group
                  // strip's when this one went with its last tab. Only shown strips count: a phone keeps the
                  // other groups mounted under display: none.
                  const shown = (element: Element | null | undefined) => Boolean(element && element.getClientRects().length > 0);
                  const moved = document.querySelector<HTMLElement>(`[data-group-strip] [role="tab"][data-tab-id="${CSS.escape(tabId)}"]`);
                  const strip = [listRef.current, ...document.querySelectorAll("[data-group-strip]")].find(shown);
                  (shown(moved) ? moved : strip?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]'))?.focus();
                });
              }}
            >
              {item.label}
            </button>
          ))}
        </SidebarPortalMenu>
      )}
    </>
  );
}
