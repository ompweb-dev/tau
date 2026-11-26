"use client";

import { memo } from "react";
import { AtSign, Copy, LocateFixed } from "lucide-react";
import { FileViewer } from "./FileViewer";
import type { Tab } from "./TabBar";
import { useI18n } from "@/lib/i18n";
import { getFileName } from "@/lib/file-paths";
import type { WorkspaceFileSource } from "@/lib/workspace-types";

/** What the focused group's shown file offers in its header row (stable callbacks; AppShell memoizes the object). */
export interface FileActions {
  /** The file belongs to the shown conversation's workspace: mention and reveal work. */
  matchesSource: boolean;
  /** The explorer is revealing this file. */
  revealed: boolean;
  onMention: () => void;
  onCopyPath: () => void;
  onReveal: () => void;
}

/** Mention, copy path and reveal, at the end of the file's header row (before its download link). */
function FileHeaderActions({ actions }: { actions: FileActions }) {
  const { t } = useI18n();
  const { matchesSource, revealed } = actions;
  return (
    <>
      <button
        type="button"
        className="file-viewer-icon-button"
        onClick={actions.onMention}
        disabled={!matchesSource}
        title={t("appShell.mentionFileInChat")}
        aria-label={t("appShell.mentionFileInChat")}
        style={{ color: "var(--accent)" }}
      >
        <AtSign size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
      <button type="button" className="file-viewer-icon-button" onClick={actions.onCopyPath} title={t("appShell.copyFilePath")} aria-label={t("appShell.copyFilePath")}>
        <Copy size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="file-viewer-icon-button"
        onClick={actions.onReveal}
        disabled={!matchesSource}
        aria-pressed={revealed}
        title={t(matchesSource ? "appShell.revealInExplorer" : "appShell.revealSourceSession")}
        aria-label={t("appShell.revealInExplorer")}
        style={revealed ? { background: "var(--bg-selected)", color: "var(--accent)" } : undefined}
      >
        <LocateFixed size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </>
  );
}

/**
 * One file tab's view. Only its group's shown file is displayed (covering the
 * group's chat) and carries the group's file panel id; the others stay mounted, hidden.
 */
export const FileTabView = memo(function FileTabView({ panelId, tab, shown, focused, activeFileMatchesSource, actions, explorerRefreshKey, onMentionLines, onOpenFile, onRevealDone }: {
  panelId: string;
  tab: Tab;
  /** The group's shown tab is this file. */
  shown: boolean;
  /** The view's group is the focused one: only there can lines be mentioned. */
  focused: boolean;
  activeFileMatchesSource: boolean;
  /** Only for the focused group's shown file. */
  actions?: FileActions;
  explorerRefreshKey: number;
  onMentionLines: (relativePath: string, startLine: number, endLine: number) => void;
  onOpenFile: (filePath: string, fileName: string, source: WorkspaceFileSource) => void;
  onRevealDone: (tabId: string, seq: number) => void;
}) {
  return (
    <div
      id={shown ? panelId : undefined}
      role={shown ? "tabpanel" : undefined}
      tabIndex={shown ? -1 : undefined}
      aria-label={shown ? tab.filePath : undefined}
      className="ui-focus-ring"
      style={{ outline: "none", display: shown ? "block" : "none", position: "absolute", inset: 0, zIndex: 1, overflow: "hidden", background: "var(--bg)" }}
    >
      <FileViewer
        filePath={tab.filePath}
        hostId={tab.hostId}
        cwd={tab.sourceCwd ?? undefined}
        sourceSessionId={tab.sourceSessionId}
        gitRefreshKey={explorerRefreshKey}
        active={shown}
        revealLine={tab.revealLine}
        onRevealDone={(seq) => onRevealDone(tab.id, seq)}
        onMentionLines={shown && focused && activeFileMatchesSource ? onMentionLines : undefined}
        headerActions={actions && <FileHeaderActions actions={actions} />}
        onOpenFile={(filePath) => onOpenFile(
          filePath,
          getFileName(filePath),
          { hostId: tab.hostId, cwd: tab.sourceCwd, sessionId: tab.sourceSessionId ?? null },
        )}
      />
    </div>
  );
});
