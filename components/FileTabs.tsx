"use client";

import { AtSign, Copy, Download, FileX, LocateFixed } from "lucide-react";
import { FileViewer } from "./FileViewer";
import type { Tab } from "./TabBar";
import { useI18n } from "@/lib/i18n";
import { getFileName } from "@/lib/file-paths";
import type { WorkspaceFileSource } from "@/lib/workspace-types";

/** Actions on the open file tab, shown at the end of the main tab strip. */
export function FileTabToolbar({ activeFileTab, fileTabs, activeFileMatchesSource, revealPath, onMentionActiveFile, onCopyActiveFilePath, onRevealActiveFile, onDownloadActiveFile, onCloseOtherFileTabs, onCloseAllFileTabs }: {
  activeFileTab: Tab;
  fileTabs: Tab[];
  /** The file belongs to the shown conversation's workspace: mention and reveal work. */
  activeFileMatchesSource: boolean;
  revealPath: string | null;
  onMentionActiveFile: () => void;
  onCopyActiveFilePath: () => void;
  onRevealActiveFile: () => void;
  onDownloadActiveFile: () => void;
  onCloseOtherFileTabs: () => void;
  onCloseAllFileTabs: () => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={activeFileTab.filePath}>
      <button
        onClick={onMentionActiveFile}
        disabled={!activeFileMatchesSource}
        title={t("appShell.mentionFileInChat")}
        aria-label={t("appShell.mentionFileInChat")}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--accent)", cursor: activeFileMatchesSource ? "pointer" : "default", opacity: activeFileMatchesSource ? 1 : 0.45 }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        <AtSign size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
      <button
        onClick={onCopyActiveFilePath}
        title={t("appShell.copyFilePath")}
        aria-label={t("appShell.copyFilePath")}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
      >
        <Copy size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        onClick={onRevealActiveFile}
        disabled={!activeFileMatchesSource}
        title={t(activeFileMatchesSource ? "appShell.revealInExplorer" : "appShell.revealSourceSession")}
        aria-label={t("appShell.revealInExplorer")}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: revealPath ? "var(--bg-hover)" : "none", border: "none", borderRadius: "var(--radius-control)", color: revealPath ? "var(--accent)" : "var(--text-dim)", cursor: activeFileMatchesSource ? "pointer" : "not-allowed", opacity: activeFileMatchesSource ? 1 : 0.5 }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = revealPath ? "var(--accent)" : "var(--text-dim)"; e.currentTarget.style.background = revealPath ? "var(--bg-hover)" : "none"; }}
      >
        <LocateFixed size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        onClick={onDownloadActiveFile}
        title={t("fileExplorer.downloadFile")}
        aria-label={t("fileExplorer.downloadFile")}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
      >
        <Download size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      {fileTabs.length > 1 && (
        <button
          onClick={onCloseOtherFileTabs}
          title={t("appShell.closeOtherTabs")}
          aria-label={t("appShell.closeOtherTabs")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 26, padding: "0 7px", background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
        >
          {t("appShell.closeOthers")}
        </button>
      )}
      <button
        onClick={onCloseAllFileTabs}
        title={t("appShell.closeAllTabs")}
        aria-label={t("appShell.closeAllTabs")}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
      >
        <FileX size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Every open file's viewer, kept mounted so switching tabs preserves scroll and preview state. */
export function FileTabViews({ fileTabs, activeFileTabId, active, activeFileMatchesSource, explorerRefreshKey, onMentionLines, onOpenFile }: {
  fileTabs: Tab[];
  activeFileTabId: string | null;
  /** A file tab, not a chat, is the shown tab. */
  active: boolean;
  activeFileMatchesSource: boolean;
  explorerRefreshKey: number;
  onMentionLines: (relativePath: string, startLine: number, endLine: number) => void;
  onOpenFile: (filePath: string, fileName: string, source: WorkspaceFileSource) => void;
}) {
  return (
    <div id="workspace-file-tabs" role="tabpanel" aria-label={fileTabs.find((tab) => tab.id === activeFileTabId)?.filePath} style={{ display: active ? "block" : "none", height: "100%", overflow: "hidden" }}>
      {fileTabs.map((tab) => (
        <div key={tab.id} style={{ display: tab.id === activeFileTabId ? "block" : "none", height: "100%" }}>
          <FileViewer
            filePath={tab.filePath}
            hostId={tab.hostId}
            cwd={tab.sourceCwd ?? undefined}
            sourceSessionId={tab.sourceSessionId}
            gitRefreshKey={explorerRefreshKey}
            active={tab.id === activeFileTabId && active}
            onMentionLines={tab.id === activeFileTabId && active && activeFileMatchesSource ? onMentionLines : undefined}
            onOpenFile={(filePath) => onOpenFile(
              filePath,
              getFileName(filePath),
              { hostId: tab.hostId, cwd: tab.sourceCwd, sessionId: tab.sourceSessionId ?? null },
            )}
          />
        </div>
      ))}
    </div>
  );
}
