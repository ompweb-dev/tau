"use client";

import { ToggleSwitch } from "@/components/ui/ToggleSwitch";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { getSubmitDuringRunBehavior, setSubmitDuringRunBehavior, type SubmitDuringRunBehavior } from "@/lib/composer-prefs";
import dynamic from "@/lib/dynamic";
import { ArrowLeft, Copy, Download, RefreshCw, RotateCcw, Search, Monitor, Play, Square, Trash2, X } from "lucide-react";
import { formatAgentEnvText, parseAgentEnvText, type AgentEnvErrorLabels } from "@/lib/pi/agent-env-policy";
import { isRecord } from "@/lib/type-guards";
import { Alert } from "@/components/ui/field";
import { ThemedSelect } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SettingsTabs, type SettingsTab, SETTINGS_CATEGORIES, getNormalizedActive } from "./SettingsTabs";
import { copyText } from "@/lib/clipboard";
import type { AppUpdateInfo } from "./AppUpdateDialog";
import { useFontSize, type FontSizePreference } from "@/hooks/useFontSize";
import { useUiScale, type UiScalePreference } from "@/hooks/useUiScale";
import { useTouchTargets, type TouchTargetsPreference } from "@/hooks/useTouchTargets";
import { useRecentRunsLimit, type RecentRunsLimitPreset } from "@/hooks/useRecentRunsLimit";
import { useSpeechSynthesis } from "@/hooks/useSpeechSynthesis";
import { useNotificationPrefs } from "@/hooks/useNotifications";
import { NOTIFICATION_TYPES, renderNotification, type NotificationType } from "@/lib/notification-events";
import {
  ensurePushSubscription,
  getNotificationDeviceId,
  getNotificationPrefs,
  getNotificationSupport,
  showSystemNotification,
  updateNotificationPrefs,
  type NotificationSupport,
} from "@/lib/notification-client";
import { setConnectionDiagnosticsEnabled, useConnectionDiagnosticsEnabled } from "@/lib/connection-diagnostics-prefs";
import type { GithubActionsOperation, GithubActionsPermission, GithubActionsPermissions } from "@/lib/web-settings";
const SettingsTabLoading = () => {
  const { t } = useI18n();
  return <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("settingsConfig.loadingSettings")}</div>;
};
const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig), { loading: SettingsTabLoading });
const SkillsConfig = dynamic(() => import("./SkillsConfig").then((module) => module.SkillsConfig), { loading: SettingsTabLoading });
const PluginsConfig = dynamic(() => import("./PluginsConfig").then((module) => module.PluginsConfig), { loading: SettingsTabLoading });
const McpConfig = dynamic(() => import("./McpConfig").then((module) => module.McpConfig), { loading: SettingsTabLoading });
const HostsConfig = dynamic(() => import("./HostsConfig").then((module) => module.HostsConfig), { loading: SettingsTabLoading });
const UsageConfig = dynamic(() => import("./UsageConfig").then((module) => module.UsageConfig), { loading: SettingsTabLoading });

type WindowsServiceStatus = {
  isWindows: boolean;
  isInstalled: boolean;
  autostart: boolean;
  isRunning: boolean;
  port: number;
  hostname: string;
  mode: "start" | "dev";
  desktopShortcutExists: boolean;
  startMenuShortcutExists: boolean;
  startupShortcutExists: boolean;
  logFile: string;
  configFile: string;
  serviceUrl: string;
  version: string;
};

/** pi's settings.json keys Settings edits (lib/pi/settings-config.ts). */
type NativeSettings = {
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  hideThinkingBlock?: boolean;
  compaction?: { enabled?: boolean; keepRecentTokens?: number };
  retry?: { enabled?: boolean; maxRetries?: number };
};

const nativeSelectStyle = {
  minHeight: "var(--control-height)",
  padding: "4px var(--control-padding-inline)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: "var(--text-sm)",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "inherit",
  cursor: "pointer",
} as const;

const chipStyle = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--bg-subtle)",
  color: "var(--text-muted)",
  fontWeight: 500,
} as const;

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const SettingsHighlightContext = createContext<string | null>(null);

type EnhancedChildProps = {
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
};

type SearchResult = {
  id: string;
  kind: "category" | "setting";
  tab: SettingsTab;
  label: string;
  description: string;
  scope?: string;
  section?: string;
};

type SettingIndexEntry = {
  id: string;
  tab: SettingsTab;
  sectionKey: string;
  labelKey: string;
  descKey: string;
  fallbackSection: string;
  fallbackLabel: string;
  fallbackDesc: string;
  scope?: "UI" | "Native OMP" | "Workspace";
};

const SETTING_INDEX: SettingIndexEntry[] = [
  // Interface & Behavior
  { id: "completion-sound", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.completionSound", descKey: "settingsConfig.completionSoundDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Completion sound", fallbackDesc: "Play a tone when the agent completes a run.", scope: "UI" },
  { id: "keep-tool-calls-collapsed", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.keepToolCallsCollapsed", descKey: "settingsConfig.keepToolCallsCollapsedDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Keep tool calls collapsed", fallbackDesc: "Show only compact headers while tools execute.", scope: "UI" },
  { id: "expand-thinking-by-default", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.expandThinkingByDefault", descKey: "settingsConfig.expandThinkingByDefaultDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Expand thinking blocks by default", fallbackDesc: "Open every thinking block as it appears, including while it streams, and keep it out of Process details so reasoning is readable without clicking each one. Collapsing a block by hand still works.", scope: "UI" },
  { id: "hide-tool-activity", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.hideToolActivity", descKey: "settingsConfig.hideToolActivityDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Hide tool activity while working", fallbackDesc: "Fold a running turn's tool calls into one Process details row, the same way a finished turn folds them. Expand the row to see each call and its result.", scope: "UI" },
  { id: "show-tool-calls-unfolded", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.showToolCallsUnfolded", descKey: "settingsConfig.showToolCallsUnfoldedDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Show tool calls outside Process details", fallbackDesc: "Keep each tool call's row visible in the transcript instead of folding it into Process details. Whether the row opens is still set by \"Keep tool calls collapsed\".", scope: "UI" },
  { id: "never-fold-activity", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.neverFoldActivity", descKey: "settingsConfig.neverFoldActivityDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Never fold tool activity", fallbackDesc: "Show thinking, tool calls and notices as their own rows in every turn instead of folding them into Process details. Overrides \"Hide tool activity while working\".", scope: "UI" },
  { id: "open-url-automatically", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.openUrlAutomatically", descKey: "settingsConfig.openUrlAutomaticallyDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Open agent links without asking", fallbackDesc: "Links the agent opens from the session you are viewing open in a new tab right away. Links from other sessions always ask first. Your browser may still block pop-ups.", scope: "UI" },
  { id: "scope-native-select-all", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.scopeNativeSelectAll", descKey: "settingsConfig.scopeNativeSelectAllDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Scope native Select All (experimental)", fallbackDesc: "Limit whole-page selections from browser or touch menus to the active message, chat, or file. May also narrow deliberate whole-page selections. Turn off if selection handles or menus misbehave. Keyboard shortcuts are unaffected.", scope: "UI" },
  { id: "tts-autoplay", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.ttsAutoplay", descKey: "settingsConfig.ttsAutoplayDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Auto-read assistant responses", fallbackDesc: "Automatically read aloud new assistant replies when completed.", scope: "UI" },
  { id: "tts-voice", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.ttsVoice", descKey: "settingsConfig.ttsVoiceDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Speech Voice", fallbackDesc: "Select the browser voice for text-to-speech reading.", scope: "UI" },
  { id: "chat-font-size", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.chatFontSize", descKey: "settingsConfig.chatFontSizeDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Chat Font Size", fallbackDesc: "Adjust text size for conversation messages, code blocks, and markdown output.", scope: "UI" },
  { id: "ui-scale", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.uiScale", descKey: "settingsConfig.uiScaleDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Interface Scale", fallbackDesc: "Adjust overall UI zoom and display density across sidebars, dialogs, buttons, and toolbars.", scope: "UI" },
  { id: "touch-targets", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.touchTargets", descKey: "settingsConfig.touchTargetsDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Touch Targets", fallbackDesc: "Adjust interactive target sizes for buttons and toolbar controls.", scope: "UI" },
  { id: "message-during-active-run", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.messageDuringActiveRun", descKey: "settingsConfig.messageDuringActiveRunDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Message during active run", fallbackDesc: "What composer does on submit while agent runs. Steer interrupts; Queue follow-up delivers after finish.", scope: "UI" },
  { id: "connection-diagnostics", tab: "general", sectionKey: "settingsConfig.interfaceBehavior", labelKey: "settingsConfig.connectionDiagnostics", descKey: "settingsConfig.connectionDiagnosticsDesc", fallbackSection: "Interface & Behavior", fallbackLabel: "Show connection diagnostics", fallbackDesc: "Adds a Connection tab to the right panel showing the connection this browser uses (WebSocket or server-sent events), its status and delivery latency statistics. Applies to this browser only.", scope: "UI" },
  // AI Model Defaults
  { id: "reasoning", tab: "models", sectionKey: "settingsConfig.modelDefaults", labelKey: "settingsConfig.reasoning", descKey: "settingsConfig.reasoningDesc", fallbackSection: "AI Model Defaults", fallbackLabel: "Reasoning", fallbackDesc: "Default effort level for thinking-capable models.", scope: "Native OMP" },
  { id: "thinking-blocks", tab: "models", sectionKey: "settingsConfig.modelDefaults", labelKey: "settingsConfig.thinkingBlocks", descKey: "settingsConfig.thinkingBlocksDesc", fallbackSection: "AI Model Defaults", fallbackLabel: "Hide Thinking Blocks", fallbackDesc: "Hide model reasoning from output view.", scope: "Native OMP" },
  // Context Compaction
  { id: "automatic-compaction", tab: "intelligence", sectionKey: "settingsConfig.contextCompaction", labelKey: "settingsConfig.automaticCompaction", descKey: "settingsConfig.automaticCompactionDesc", fallbackSection: "Context Compaction", fallbackLabel: "Automatic Compaction", fallbackDesc: "Compact context before model context limit is hit.", scope: "Native OMP" },
  // Automatic Retry
  { id: "automatic-retry", tab: "intelligence", sectionKey: "settingsConfig.automaticRetry", labelKey: "settingsConfig.retryToggle", descKey: "settingsConfig.retryToggleDesc", fallbackSection: "Automatic Retry", fallbackLabel: "Automatic Retry", fallbackDesc: "Retry failed turns automatically.", scope: "Native OMP" },
  { id: "max-attempts", tab: "intelligence", sectionKey: "settingsConfig.automaticRetry", labelKey: "settingsConfig.maxAttempts", descKey: "settingsConfig.maxAttemptsDesc", fallbackSection: "Automatic Retry", fallbackLabel: "Max Attempts", fallbackDesc: "Retry limit before giving up.", scope: "Native OMP" },
  // Usage & Analytics
  { id: "usage-summary", tab: "usage", sectionKey: "settingsTabs.usage.label", labelKey: "usageConfig.title", descKey: "settingsTabs.usage.description", fallbackSection: "Usage", fallbackLabel: "Usage & Analytics", fallbackDesc: "Tokens, costs, cache analytics, and model breakdown", scope: "UI" },
  { id: "token-cost", tab: "usage", sectionKey: "settingsTabs.usage.label", labelKey: "usageConfig.rawTokenCost", descKey: "usageConfig.billedAtFullRate", fallbackSection: "Usage", fallbackLabel: "Raw Token Cost", fallbackDesc: "Token expenditure across providers and models", scope: "UI" },
  { id: "cache-savings", tab: "usage", sectionKey: "settingsTabs.usage.label", labelKey: "usageConfig.cacheSavings", descKey: "usageConfig.costQuality", fallbackSection: "Usage", fallbackLabel: "Cache Savings", fallbackDesc: "Prompt caching savings and cost quality breakdown", scope: "UI" },
  { id: "model-breakdown", tab: "usage", sectionKey: "settingsTabs.usage.label", labelKey: "usageConfig.breakdown", descKey: "usageConfig.model", fallbackSection: "Usage", fallbackLabel: "Model Breakdown", fallbackDesc: "Historical token usage and cost per model, day, and project", scope: "UI" },
  // Windows Background Service & System Tray
  { id: "auto-resume-sessions", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.autoResumeSessions", descKey: "settingsConfig.autoResumeSessionsDesc", fallbackSection: "System", fallbackLabel: "Resume running sessions after a restart", fallbackDesc: "When tau restarts while agents are working, restart those sessions and tell each agent: \"Session interrupted and resumed. Continue as you would have done without the interruption.\" Work in progress at the moment of the restart, such as a running command, is lost." },
  { id: "agent-tools-cross-session", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.agentTools", descKey: "settingsConfig.agentToolsDesc", fallbackSection: "System", fallbackLabel: "Agent tools (cross-session)", fallbackDesc: "Allow cross-session tools and GitHub tools for watching and reading issues and pull requests, writing comments and threads, and managing Actions workflow runs. Requires the GitHub CLI (gh) installed and logged in on this server." },
  { id: "github-writes-unasked", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.githubWritesUnasked", descKey: "settingsConfig.githubWritesUnaskedDesc", fallbackSection: "System", fallbackLabel: "Allow agent GitHub writes without asking", fallbackDesc: "Let agents post comments, reply in review threads and resolve threads through this server's gh login without a confirmation each time. Off: each of those comment and thread writes asks in the session first." },
  { id: "github-actions-dispatch", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.githubActionsDispatch", descKey: "settingsConfig.githubActionsDispatchDesc", fallbackSection: "System", fallbackLabel: "Dispatch workflows", fallbackDesc: "Choose whether agents may start GitHub Actions workflows." },
  { id: "github-actions-cancel", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.githubActionsCancel", descKey: "settingsConfig.githubActionsCancelDesc", fallbackSection: "System", fallbackLabel: "Cancel workflow runs", fallbackDesc: "Choose whether agents may cancel running GitHub Actions workflows." },
  { id: "github-actions-rerun", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.githubActionsRerun", descKey: "settingsConfig.githubActionsRerunDesc", fallbackSection: "System", fallbackLabel: "Rerun workflow runs", fallbackDesc: "Choose whether agents may rerun GitHub Actions workflow runs." },
  { id: "upload-retention", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.uploadRetention", descKey: "settingsConfig.uploadRetentionDesc", fallbackSection: "System", fallbackLabel: "Delete sent uploads after", fallbackDesc: "Files attached As file are deleted from each session's local://uploads folder on every host, archived sessions included, once they are this old. Never keeps them for ever." },
  { id: "agent-env", tab: "system", sectionKey: "settingsConfig.systemUpdates", labelKey: "settingsConfig.agentEnv", descKey: "settingsConfig.agentEnvDesc", fallbackSection: "System", fallbackLabel: "Agent environment variables", fallbackDesc: "Extra environment variables passed to the omp process, one KEY=VALUE per line. Applied to sessions started after saving.", scope: "UI" },
  { id: "windows-service-autostart", tab: "system", sectionKey: "settingsConfig.windowsServiceTitle", labelKey: "settingsConfig.windowsServiceAutostart", descKey: "settingsConfig.windowsServiceAutostartDesc", fallbackSection: "Windows Background Service & System Tray", fallbackLabel: "Start with Windows", fallbackDesc: "Launch background service quietly in system tray when logging into Windows.", scope: "UI" },
  { id: "windows-service-shortcuts", tab: "system", sectionKey: "settingsConfig.windowsServiceTitle", labelKey: "settingsConfig.windowsServiceInstallBtn", descKey: "settingsConfig.windowsServiceDesc", fallbackSection: "Windows Background Service & System Tray", fallbackLabel: "Install Service & Shortcuts", fallbackDesc: "Manage background service execution, system tray monitor, Windows logon autostart, and Desktop shortcuts.", scope: "UI" },
  // Notifications
  { id: "notifications-enable", tab: "notifications", sectionKey: "notifications.title", labelKey: "notifications.enable", descKey: "notifications.enableDesc", fallbackSection: "Notifications", fallbackLabel: "Enable notifications", fallbackDesc: "Asks the browser for permission to show notifications.", scope: "UI" },
  { id: "notifications-completed", tab: "notifications", sectionKey: "notifications.title", labelKey: "notifications.typeCompleted", descKey: "notifications.typeCompletedDesc", fallbackSection: "Notifications", fallbackLabel: "Task finished", fallbackDesc: "A prompt and the background work it started are done. Subagents never notify.", scope: "UI" },
  { id: "notifications-input", tab: "notifications", sectionKey: "notifications.title", labelKey: "notifications.typeInput", descKey: "notifications.typeInputDesc", fallbackSection: "Notifications", fallbackLabel: "Waiting for input", fallbackDesc: "The agent asks a question or needs an approval.", scope: "UI" },
  { id: "notifications-error", tab: "notifications", sectionKey: "notifications.title", labelKey: "notifications.typeError", descKey: "notifications.typeErrorDesc", fallbackSection: "Notifications", fallbackLabel: "Run failed", fallbackDesc: "A run stops with an error after retries and fallbacks, or the omp process exits.", scope: "UI" },
  { id: "notifications-modelSwitch", tab: "notifications", sectionKey: "notifications.title", labelKey: "notifications.typeModelSwitch", descKey: "notifications.typeModelSwitchDesc", fallbackSection: "Notifications", fallbackLabel: "Model switched automatically", fallbackDesc: "omp switches models on its own: a fallback after a refusal, rate limit, or usage limit, or a prewalk / plan hand-off.", scope: "UI" },
  { id: "notifications-when-active", tab: "notifications", sectionKey: "notifications.title", labelKey: "notifications.whenActive", descKey: "notifications.whenActiveDesc", fallbackSection: "Notifications", fallbackLabel: "When I'm using tau in another tab", fallbackDesc: "Nothing is shown for the session you are viewing.", scope: "UI" },
];

function SearchResultsList({ results, query, onSelect }: { results: SearchResult[]; query: string; onSelect: (result: SearchResult) => void }) {
  const { t, tn } = useI18n();
  const isMobile = useIsMobile();
  const formatScope = (s?: string) => {
    if (s === "UI") return t("settingsConfig.chipUI");
    if (s === "Native OMP") return t("settingsConfig.chipNativeOMP");
    if (s === "Workspace") return t("settingsConfig.chipWorkspace");
    return s;
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg)", padding: isMobile ? "16px 14px 32px" : "32px 24px 64px" }}>
      <div className="settings-panel-inner" style={{ gap: 12 }}>
        <div style={{ fontSize: "var(--text-md)", color: "var(--text-muted)", marginBottom: 4 }}>
          {results.length === 0 ? t("settingsConfig.noSettingsMatch", { query }) : tn("settingsConfig.searchResults", results.length, { count: results.length, query })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => onSelect(result)}
              className="settings-card"
              style={{
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 4,
                padding: "14px 18px",
                width: "100%",
                boxSizing: "border-box",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{result.label}</span>
                {result.kind === "category" && (
                  <span style={chipStyle}>{t("settingsConfig.chipSection")}</span>
                )}
                {result.scope && (
                  <span style={chipStyle}>{formatScope(result.scope)}</span>
                )}
              </div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.45 }}>{result.description}</div>
              {result.section && <div style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{result.section}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Server-side tau setting (lib/web-settings.ts), loaded on mount. */
function AutoResumeSessionsSetting() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/web-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { autoResumeSessions?: boolean } | null) => { if (alive) setEnabled(data?.autoResumeSessions === true); })
      .catch(() => { if (alive) setEnabled(false); });
    return () => { alive = false; };
  }, []);
  const change = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    try {
      const res = await fetch("/api/web-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoResumeSessions: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      setEnabled(previous);
      toast.error(t("settingsConfig.autoResumeSessionsSaveFailed"), error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <NativeSetting searchId="auto-resume-sessions" label={t("settingsConfig.autoResumeSessions")} description={t("settingsConfig.autoResumeSessionsDesc")}>
      <ToggleSwitch checked={enabled === true} disabled={enabled === null} onChange={(next) => void change(next)} />
    </NativeSetting>
  );
}

/** Server-side tau setting (issue #275): cross-session agent tools.
 * Off by default; mirrors AutoResumeSessionsSetting above. */
function AgentToolsSetting() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/web-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { agentToolsEnabled?: boolean } | null) => { if (alive) setEnabled(data?.agentToolsEnabled === true); })
      .catch(() => { if (alive) setEnabled(false); });
    return () => { alive = false; };
  }, []);
  const change = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    try {
      const res = await fetch("/api/web-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentToolsEnabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      setEnabled(previous);
      toast.error(t("settingsConfig.agentToolsSaveFailed"), error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <NativeSetting searchId="agent-tools-cross-session" label={t("settingsConfig.agentTools")} description={t("settingsConfig.agentToolsDesc")}>
      <ToggleSwitch checked={enabled === true} disabled={enabled === null} onChange={(next) => void change(next)} />
    </NativeSetting>
  );
}

function GithubWritesSetting() {
  const { t } = useI18n();
  // null until loaded, and after a failed load: showing "off" there could hide writes the server allows.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // Blocks a second change until the save and any uncertain-result reload finish.
  const [saving, setSaving] = useState(false);
  const load = useCallback(async (): Promise<boolean | null> => {
    try {
      const res = await fetch("/api/web-settings");
      if (!res.ok) return null;
      const data: { githubWritesUnasked?: boolean } = await res.json();
      return typeof data.githubWritesUnasked === "boolean" ? data.githubWritesUnasked : null;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    let alive = true;
    void load().then((value) => { if (alive) setEnabled(value); });
    return () => { alive = false; };
  }, [load]);
  const change = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    try {
      const res = await fetch("/api/web-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubWritesUnasked: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      setEnabled(null);
      toast.error(t("settingsConfig.githubWritesUnaskedSaveFailed"), error instanceof Error ? error.message : String(error));
      setEnabled(await load());
    } finally {
      setSaving(false);
    }
  };
  return (
    <NativeSetting searchId="github-writes-unasked" label={t("settingsConfig.githubWritesUnasked")} description={t("settingsConfig.githubWritesUnaskedDesc")}>
      <ToggleSwitch checked={enabled === true} disabled={enabled === null || saving} onChange={(next) => void change(next)} />
    </NativeSetting>
  );
}

const GITHUB_ACTIONS_OPERATIONS: readonly GithubActionsOperation[] = ["dispatch", "cancel", "rerun"];

function GithubActionsPermissionsSetting() {
  const { t } = useI18n();
  const [permissions, setPermissions] = useState<GithubActionsPermissions | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async (response?: Response): Promise<GithubActionsPermissions | null> => {
    try {
      const res = response ?? await fetch("/api/web-settings");
      if (!res.ok) return null;
      const data: { githubActionsPermissions?: unknown } = await res.json();
      if (!isRecord(data.githubActionsPermissions)) return null;
      const values = data.githubActionsPermissions;
      if (!GITHUB_ACTIONS_OPERATIONS.every((operation) => values[operation] === "deny" || values[operation] === "ask" || values[operation] === "allow")) return null;
      return {
        dispatch: values.dispatch as GithubActionsPermission,
        cancel: values.cancel as GithubActionsPermission,
        rerun: values.rerun as GithubActionsPermission,
      };
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    let alive = true;
    void load().then((value) => { if (alive) setPermissions(value); });
    return () => { alive = false; };
  }, [load]);
  const change = async (operation: GithubActionsOperation, next: GithubActionsPermission) => {
    if (!permissions) return;
    setPermissions({ ...permissions, [operation]: next });
    setSaving(true);
    try {
      const res = await fetch("/api/web-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubActionsPermissions: { [operation]: next } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await load(res);
      if (!saved) throw new Error("Invalid GitHub Actions permissions response");
      setPermissions(saved);
    } catch (error) {
      setPermissions(null);
      toast.error(t("settingsConfig.githubActionsSaveFailed"), error instanceof Error ? error.message : String(error));
      setPermissions(await load());
    } finally {
      setSaving(false);
    }
  };
  const options = [
    { value: "deny", label: t("settingsConfig.githubActionsPermissionDeny") },
    { value: "ask", label: t("settingsConfig.githubActionsPermissionAsk") },
    { value: "allow", label: t("settingsConfig.githubActionsPermissionAllow") },
  ];
  const rows: Array<{ operation: GithubActionsOperation; label: string; description: string }> = [
    { operation: "dispatch", label: t("settingsConfig.githubActionsDispatch"), description: t("settingsConfig.githubActionsDispatchDesc") },
    { operation: "cancel", label: t("settingsConfig.githubActionsCancel"), description: t("settingsConfig.githubActionsCancelDesc") },
    { operation: "rerun", label: t("settingsConfig.githubActionsRerun"), description: t("settingsConfig.githubActionsRerunDesc") },
  ];
  return rows.map(({ operation, label, description }) => (
    <NativeSetting key={operation} searchId={`github-actions-${operation}`} label={label} description={description}>
      <ThemedSelect
        style={nativeSelectStyle}
        value={permissions?.[operation] ?? "ask"}
        disabled={permissions === null || saving}
        options={options}
        onChange={(next) => void change(operation, next as GithubActionsPermission)}
      />
    </NativeSetting>
  ));
}

const UPLOAD_RETENTION_CHOICES: readonly (number | null)[] = [null, 7, 30, 90];

/** Server-side tau setting (lib/web-settings.ts): every host's daemon applies it to its own sessions' uploads. */
function UploadRetentionSetting() {
  const { t, tn } = useI18n();
  // undefined until loaded; null is "Never".
  const [days, setDays] = useState<number | null | undefined>(undefined);
  // Blocks a second change until the save lands: two PUTs in flight could finish out of order and leave the older one saved.
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/web-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { uploadRetentionDays?: number | null } | null) => { if (alive && data && data.uploadRetentionDays !== undefined) setDays(data.uploadRetentionDays); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const change = async (next: number | null) => {
    const previous = days;
    setDays(next);
    setSaving(true);
    try {
      const res = await fetch("/api/web-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadRetentionDays: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      setDays(previous);
      toast.error(t("settingsConfig.uploadRetentionSaveFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  // A value set through the API (14 days) stays visible as its own choice.
  const choices = days === undefined || UPLOAD_RETENTION_CHOICES.includes(days) ? UPLOAD_RETENTION_CHOICES : [...UPLOAD_RETENTION_CHOICES, days];
  return (
    <NativeSetting searchId="upload-retention" label={t("settingsConfig.uploadRetention")} description={t("settingsConfig.uploadRetentionDesc")}>
      <ThemedSelect
        style={nativeSelectStyle}
        value={days === undefined ? "30" : String(days)}
        disabled={days === undefined || saving}
        onChange={(nextValue) => void change(nextValue === "null" ? null : Number(nextValue))}
        options={choices.map((choice) => (({ value: String(choice), label: choice === null ? t("settingsConfig.uploadRetentionNever") : tn("settingsConfig.uploadRetentionDays", choice, { count: choice }) })))}
      />
    </NativeSetting>
  );
}

/** Server-side tau setting (issue #104): KEY=VALUE text injected into the
 * `omp` child process. Parsing/validation lives in lib/pi/agent-env.ts; this only
 * feeds it localized messages and renders the result. `cluster`: the members run it too (spec K1). */
function AgentEnvSetting({ cluster }: { cluster: boolean }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const errorLabels = useMemo<AgentEnvErrorLabels>(
    () => ({
      missingSeparator: (line) => t("settingsConfig.agentEnvErrMissingSeparator", { line }),
      emptyName: (line) => t("settingsConfig.agentEnvErrEmptyName", { line }),
      invalidName: (line, name) => t("settingsConfig.agentEnvErrInvalidName", { line, name }),
      deniedName: (line, name) => t("settingsConfig.agentEnvErrDenied", { line, name }),
    }),
    [t],
  );

  useEffect(() => {
    let alive = true;
    fetch("/api/web-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { agentEnv?: Record<string, string> } | null) => {
        if (!alive) return;
        setText(formatAgentEnvText(isRecord(data?.agentEnv) ? data.agentEnv : {}));
        setLoaded(true);
      })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  const { errors } = useMemo(() => parseAgentEnvText(text, errorLabels), [text, errorLabels]);

  const save = async () => {
    if (errors.length > 0) return;
    setSaving(true);
    try {
      const res = await fetch("/api/web-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentEnv: text }),
      });
      const data = (await res.json().catch(() => null)) as { agentEnv?: Record<string, string>; errors?: string[] } | null;
      if (!res.ok) {
        throw new Error(
          data?.errors?.length
            ? data.errors.join("\n")
            : data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : `HTTP ${res.status}`,
        );
      }
      // Re-render from the server's canonical form so the textarea matches what is stored.
      setText(formatAgentEnvText(isRecord(data?.agentEnv) ? data.agentEnv : {}));
      toast.success(t("settingsConfig.agentEnvSaved"));
    } catch (error) {
      toast.error(t("settingsConfig.agentEnvSaveFailed"), error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <NativeSetting searchId="agent-env" scope="UI" label={t("settingsConfig.agentEnv")} description={t("settingsConfig.agentEnvDesc")}>
      <div className="settings-card-block" style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", minWidth: 0 }}>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={5}
          disabled={!loaded}
          placeholder={t("settingsConfig.agentEnvPlaceholder")}
          aria-label={t("settingsConfig.agentEnv")}
          aria-invalid={errors.length > 0 || undefined}
          aria-describedby="agent-env-note"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "7px 9px",
            border: `1px solid ${errors.length > 0 ? "var(--status-error)" : "var(--border)"}`,
            borderRadius: "var(--radius-control)",
            background: "var(--bg)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.45,
            minHeight: 96,
            fieldSizing: "content",
            resize: "vertical",
            outline: "none",
          }}
        />
        {errors.length > 0 && (
          <ul role="alert" aria-label={t("settingsConfig.agentEnvErrors")} style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 }}>
            {errors.map((error) => (
              <li key={error} style={{ fontSize: 11, color: "var(--status-error)", lineHeight: 1.4, overflowWrap: "anywhere" }}>{error}</li>
            ))}
          </ul>
        )}
        <p id="agent-env-note" style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("settingsConfig.agentEnvNote")}</p>
        {cluster && <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settings.clusterConfigNotice")}</p>}
        <div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !loaded || errors.length > 0}
            style={{
              padding: "6px 14px",
              border: "1px solid var(--accent-strong)",
              borderRadius: "var(--radius-control)",
              background: "var(--accent-strong)",
              color: "var(--on-accent)",
              cursor: saving || errors.length > 0 ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              opacity: saving || !loaded || errors.length > 0 ? 0.6 : 1,
            }}
          >
            {saving ? t("settingsConfig.agentEnvSaving") : t("settingsConfig.agentEnvSave")}
          </button>
        </div>
      </div>
    </NativeSetting>
  );
}

const NOTIFICATION_TYPE_LABELS: Record<NotificationType, { label: string; desc: string }> = {
  completed: { label: "notifications.typeCompleted", desc: "notifications.typeCompletedDesc" },
  input: { label: "notifications.typeInput", desc: "notifications.typeInputDesc" },
  error: { label: "notifications.typeError", desc: "notifications.typeErrorDesc" },
  modelSwitch: { label: "notifications.typeModelSwitch", desc: "notifications.typeModelSwitchDesc" },
};

const NOTIFICATION_STATUS_KEYS: Record<Exclude<NotificationSupport, "push" | "no-push">, string> = {
  insecure: "notifications.statusInsecure",
  "ios-install": "notifications.statusIosInstall",
  unsupported: "notifications.statusUnsupported",
  denied: "notifications.statusDenied",
};

/** Per-device notification prefs (lib/notification-client.ts), mirrored to the server. */
function NotificationSettingsPanel() {
  const { t, locale } = useI18n();
  const prefs = useNotificationPrefs();
  const [support, setSupport] = useState<NotificationSupport | null>(null);
  const [pushActive, setPushActive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setSupport(getNotificationSupport());
    // Enabled: join (or redo) the app's startup repair, which is single-flight,
    // so the status reflects the subscription after any repair, not before it.
    const pushState: Promise<boolean> = getNotificationPrefs().enabled
      ? ensurePushSubscription()
      : fetch(`/api/notifications/devices?deviceId=${encodeURIComponent(getNotificationDeviceId())}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((data: { subscribed?: boolean } | null) => data?.subscribed === true);
    pushState.then((active) => { if (alive) setPushActive(active); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const save = (patch: Parameters<typeof updateNotificationPrefs>[0]) => {
    void updateNotificationPrefs(patch).catch((error: unknown) => toast.error(t("notifications.saveFailed"), errorText(error)));
  };

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      // First await inside the click: Safari only prompts during the user gesture.
      if (enabled && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
      await updateNotificationPrefs({ enabled, locale });
      if (enabled) setPushActive(await ensurePushSubscription());
    } catch (error) {
      toast.error(t("notifications.enableFailed", { error: errorText(error) }));
    } finally {
      setSupport(getNotificationSupport());
      setBusy(false);
    }
  };

  // With push, the server sends a real push; otherwise this tab shows one itself.
  const sendTest = async () => {
    const testNotification = renderNotification({ type: "test", sessionId: "", sessionName: "tau" }, t);
    try {
      if (pushActive) {
        const res = await fetch("/api/notifications/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId: getNotificationDeviceId() }),
        });
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          // The server drops a subscription the push service reports gone;
          // resubscribe so the next test (and real pushes) can reach this device.
          setPushActive(await ensurePushSubscription().catch(() => false));
          throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
        }
      } else if (!(await showSystemNotification(testNotification))) {
        // No system notifications here (plain HTTP, permission missing): in-app toasts are what this browser gets.
        toast.info(testNotification.title, testNotification.body);
        return;
      }
      toast.success(t("notifications.testSent"));
    } catch (error) {
      toast.error(t("notifications.testFailed"), errorText(error));
    }
  };

  let status: string | null = null;
  if (support && support !== "push" && support !== "no-push") status = t(NOTIFICATION_STATUS_KEYS[support]);
  else if (support && prefs.enabled) {
    if (Notification.permission !== "granted") status = t("notifications.statusPermission");
    else status = t(pushActive ? "notifications.statusPush" : "notifications.statusInPage");
  }

  return (
    <>
      <NativeSetting searchId="notifications-enable" scope="UI" label={t("notifications.enable")} description={t("notifications.enableDesc")}>
        <ToggleSwitch checked={prefs.enabled} disabled={busy} onChange={(next) => void setEnabled(next)} />
      </NativeSetting>
      {status && <Alert variant={support === "push" || support === "no-push" ? "info" : "warning"} description={status} />}
      {NOTIFICATION_TYPES.map((type) => (
        <NativeSetting key={type} searchId={`notifications-${type}`} scope="UI" disabled={!prefs.enabled} label={t(NOTIFICATION_TYPE_LABELS[type].label)} description={t(NOTIFICATION_TYPE_LABELS[type].desc)}>
          <ToggleSwitch checked={prefs.types[type]} disabled={!prefs.enabled} onChange={(next) => save({ types: { ...prefs.types, [type]: next } })} />
        </NativeSetting>
      ))}
      <NativeSetting searchId="notifications-when-active" scope="UI" disabled={!prefs.enabled} label={t("notifications.whenActive")} description={t("notifications.whenActiveDesc")}>
        <ThemedSelect
          style={nativeSelectStyle}
          value={prefs.whenActive}
          disabled={!prefs.enabled}
          onChange={(nextValue) => save({ whenActive: nextValue === "system" ? "system" : "toast" })}
          options={[
            { value: "toast", label: t("notifications.whenActiveToast") },
            { value: "system", label: t("notifications.whenActiveSystem") },
          ]}
        />
      </NativeSetting>
      <div>
        <button
          type="button"
          onClick={() => void sendTest()}
          disabled={!prefs.enabled}
          style={{
            padding: "6px 14px",
            border: "1px solid var(--accent-strong)",
            borderRadius: "var(--radius-control)",
            background: "var(--accent-strong)",
            color: "var(--on-accent)",
            cursor: prefs.enabled ? "pointer" : "not-allowed",
            fontSize: 12,
            fontWeight: 600,
            opacity: prefs.enabled ? 1 : 0.6,
          }}
        >
          {t("notifications.test")}
        </button>
      </div>
    </>
  );
}

/** `disabled` only dims the row; the child control must be disabled itself. */
function NativeSetting({ label, description, scope, searchId, disabled, children }: { label: string; description: string; scope?: "UI" | "Native OMP" | "Workspace"; searchId?: string; disabled?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const highlightId = useContext(SettingsHighlightContext);
  const settingSlug = searchId || slugify(label);
  const highlighted = highlightId !== null && (highlightId === settingSlug || highlightId === slugify(label));
  const settingId = 'setting-' + settingSlug;
  const labelId = 'setting-label-' + settingSlug;
  const descId = 'setting-desc-' + settingSlug;

  const formatScope = (s?: string) => {
    if (s === "UI") return t("settingsConfig.chipUI");
    if (s === "Native OMP") return t("settingsConfig.chipNativeOMP");
    if (s === "Workspace") return t("settingsConfig.chipWorkspace");
    return s;
  };

  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  let enhancedChild = children;
  if (isValidElement(children)) {
    const childProps = children.props as EnhancedChildProps;
    enhancedChild = cloneElement(children as ReactElement<EnhancedChildProps>, {
      id: childProps.id || settingId,
      "aria-labelledby": childProps["aria-labelledby"] || labelId,
      "aria-describedby": childProps["aria-describedby"] || descId,
      "aria-label": childProps["aria-label"] || label,
    });
  }

  return (
    <div
      ref={ref}
      data-search-id={settingSlug}
      className="settings-card"
      style={{
        minWidth: 0,
        width: "100%",
        boxSizing: "border-box",
        marginBottom: 10,
        opacity: disabled ? 0.5 : 1,
        transition: "box-shadow var(--dur-fast), border-color var(--dur-fast), opacity var(--dur-fast)",
        ...(highlighted ? { borderColor: "var(--accent)", boxShadow: "0 0 0 2px var(--accent)" } : {}),
      }}
    >
      <div className="settings-card-text">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <label id={labelId} htmlFor={settingId} className="settings-card-title" style={{ cursor: disabled ? "default" : "pointer" }}>{label}</label>
          {scope && (
            <span style={chipStyle}>
              {formatScope(scope)}
            </span>
          )}
        </div>
        <span id={descId} className="settings-card-desc">{description}</span>
      </div>
      <span className="settings-card-control">{enhancedChild}</span>
    </div>
  );
}

/** Tabs that edit the mirrored configuration (spec K1): `settings.json` (packages included), `models.json`, MCP servers,
 * skills. Interface, System, usage, hosts and notifications belong to this browser or this server only. */
const CLUSTER_CONFIG_TABS: readonly SettingsTab[] = ["models", "providers", "intelligence", "mcp", "skills", "plugins"];

export function SettingsConfig({ activeTab, toolCallsDefaultCollapsed, onToolCallsDefaultCollapsedChange, hideToolActivity, onHideToolActivityChange, neverFoldActivity, onNeverFoldActivityChange, showToolCallsUnfolded, onShowToolCallsUnfoldedChange, expandThinkingByDefault, onExpandThinkingByDefaultChange, onHideThinkingBlockChange, scopeNativeSelectAll, onScopeNativeSelectAllChange, openUrlAutomatically, onOpenUrlAutomaticallyChange, cwd, remoteHost, cluster, sessionId, onModelsSaved, onPluginsReloaded, appUpdate, onRefreshAppUpdate, onRequestAppUpdate, onSelectTab, onClose }: {
  activeTab: SettingsTab;
  toolCallsDefaultCollapsed: boolean;
  onToolCallsDefaultCollapsedChange: (collapsed: boolean) => void;
  hideToolActivity: boolean;
  onHideToolActivityChange: (hide: boolean) => void;
  neverFoldActivity: boolean;
  onNeverFoldActivityChange: (never: boolean) => void;
  showToolCallsUnfolded: boolean;
  onShowToolCallsUnfoldedChange: (show: boolean) => void;
  expandThinkingByDefault: boolean;
  onExpandThinkingByDefaultChange: (expand: boolean) => void;
  onHideThinkingBlockChange?: (hide: boolean) => void;
  scopeNativeSelectAll: boolean;
  onScopeNativeSelectAllChange: (enabled: boolean) => void;
  openUrlAutomatically: boolean;
  onOpenUrlAutomaticallyChange: (enabled: boolean) => void;
  cwd: string | null;
  /** `cwd` lives on a remote host: its MCP settings are not available yet, unless it is a cluster member (`cluster`). */
  remoteHost: boolean;
  /** `cwd` or `sessionId` is a session or project of the cluster: its settings are the master's, this machine's (spec K7). */
  cluster: boolean;
  sessionId: string | null;
  onModelsSaved: () => void;
  onPluginsReloaded: () => void;
  appUpdate: AppUpdateInfo | null;
  onRefreshAppUpdate: (force?: boolean) => Promise<AppUpdateInfo | null>;
  onRequestAppUpdate: () => void;
  onSelectTab: (tab: SettingsTab) => void;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const workspaceReady = cwd !== null;
  // Workspace-scoped panels read this machine's disk: not for a remote workspace yet.
  const remoteUnavailable = <p role="status" style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>{t("hosts.notAvailableRemote")}</p>;
  // On another member the panels act on this machine's user level, which every member runs; that member's workspace
  // and session are not this machine's, so they are left out with the project-level parts they would show. MCP alone
  // keeps the session, to read its live status from the process running there (spec K7).
  const panelsUnavailable = remoteHost && !cluster;
  const panelCwd = remoteHost ? null : cwd;
  const panelSessionId = remoteHost ? null : sessionId;
  const { fontSize, setFontSize } = useFontSize();
  const { uiScale, setUiScale } = useUiScale();
  const { touchTargets, setTouchTargets } = useTouchTargets();
  const {
    preset: recentRunsPreset,
    customValue: recentRunsCustomValue,
    setPreset: setRecentRunsPreset,
    setCustomValue: setRecentRunsCustomValue,
  } = useRecentRunsLimit();
  const {
    isSupported: ttsSupported,
    autoPlayEnabled: ttsAutoPlay,
    setAutoPlay: setTtsAutoPlay,
    voices: ttsVoices,
    selectedVoiceURI: ttsVoiceURI,
    setSelectedVoiceURI: setTtsVoiceURI,
  } = useSpeechSynthesis();
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [submitBehavior, setSubmitBehavior] = useState<SubmitDuringRunBehavior>(() => getSubmitDuringRunBehavior());
  const connectionDiagnostics = useConnectionDiagnosticsEnabled();
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const value = window.localStorage.getItem("omp-sound-enabled");
      return value === null ? true : value === "true";
    } catch {
      return true;
    }
  });
  const [checkingAppUpdate, setCheckingAppUpdate] = useState(false);
  const [appUpdateMessage, setAppUpdateMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [windowsService, setWindowsService] = useState<WindowsServiceStatus | null>(null);
  const [loadingWindowsService, setLoadingWindowsService] = useState(false);
  const [windowsServiceActionPending, setWindowsServiceActionPending] = useState(false);

  const appUpdateIsAvailable = Boolean(appUpdate?.updateAvailable);
  const appUpdatesDisabled = Boolean(appUpdate?.updatesDisabled);
  const systemNeedsAttention = appUpdateIsAvailable;

  const attentionTabs = useMemo<Partial<Record<SettingsTab, boolean | string>>>(() => {
    const tabs: Partial<Record<SettingsTab, boolean | string>> = {};
    if (systemNeedsAttention) {
      tabs.system = t("settingsTabs.updateAvailable");
    }
    return tabs;
  }, [systemNeedsAttention, t]);

  const fetchWindowsServiceStatus = useCallback(async () => {
    try {
      setLoadingWindowsService(true);
      const res = await fetch("/api/windows-service");
      if (res.ok) {
        const data = (await res.json()) as WindowsServiceStatus;
        setWindowsService(data);
      }
    } catch {
      // ignore
    } finally {
      setLoadingWindowsService(false);
    }
  }, []);

  const performWindowsServiceAction = useCallback(async (action: "install" | "uninstall" | "toggle-autostart" | "start" | "stop" | "restart", payload: object = {}) => {
    try {
      setWindowsServiceActionPending(true);
      setMessage(null);
      const res = await fetch("/api/windows-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; status?: WindowsServiceStatus; message?: string };
      if (!res.ok || data.error) {
        setMessage(data.error || t("settingsConfig.windowsServiceActionFailed"));
      } else {
        if (data.status) setWindowsService(data.status);
        setMessage(data.message || t("settingsConfig.windowsServiceActionSuccess"));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t("settingsConfig.windowsServiceActionFailed"));
    } finally {
      setWindowsServiceActionPending(false);
    }
  }, [t]);


  const [nativeSettings, setNativeSettings] = useState<NativeSettings | null>(null);
  const [nativeSettingsError, setNativeSettingsError] = useState<string | null>(null);
  const [nativeSettingsLoading, setNativeSettingsLoading] = useState(true);
  const [nativeSavesInFlight, setNativeSavesInFlight] = useState(0);
  const [isPending, startTransition] = useTransition();
  const latestNativeSettingsRef = useRef<NativeSettings | null>(null);
  const nativeSaveDrainingRef = useRef(false);
  const nativeSettingsMutatedRef = useRef(false);

  const loadNativeSettings = useCallback(() => {
    nativeSettingsMutatedRef.current = false;
    setNativeSettingsLoading(true);
    setNativeSettingsError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    fetch("/api/pi-settings", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: { settings?: NativeSettings }) => {
        if (!nativeSettingsMutatedRef.current) setNativeSettings(data.settings ?? {});
      })
      .catch((error) => setNativeSettingsError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        clearTimeout(timeout);
        setNativeSettingsLoading(false);
      });
  }, []);

  useEffect(() => {
    void loadNativeSettings();
  }, [loadNativeSettings]);

  const saveNativeSettings = useCallback((next: NativeSettings) => {
    nativeSettingsMutatedRef.current = true;
    setNativeSettings(next);
    setNativeSettingsError(null);
    latestNativeSettingsRef.current = next;
    if (nativeSaveDrainingRef.current) return;
    nativeSaveDrainingRef.current = true;
    setNativeSavesInFlight((count) => count + 1);

    void (async () => {
      try {
        while (latestNativeSettingsRef.current !== null) {
          const snapshot = latestNativeSettingsRef.current;
          latestNativeSettingsRef.current = null;
          try {
            const response = await fetch("/api/pi-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: snapshot }) });
            const data = (await response.json()) as { settings?: NativeSettings; error?: string };
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
            if (latestNativeSettingsRef.current === null) setNativeSettings(data.settings ?? snapshot);
          } catch (error) {
            setNativeSettingsError(error instanceof Error ? error.message : String(error));
            break;
          }
        }
      } finally {
        nativeSaveDrainingRef.current = false;
        setNativeSavesInFlight((count) => Math.max(0, count - 1));
      }
    })();
  }, []);

  const currentSettings = useCallback((): NativeSettings => latestNativeSettingsRef.current ?? nativeSettings ?? {}, [nativeSettings]);

  const patchSettings = useCallback((patch: Partial<NativeSettings>) => {
    void saveNativeSettings({ ...currentSettings(), ...patch });
  }, [currentSettings, saveNativeSettings]);

  const patchSection = useCallback(<K extends keyof NativeSettings,>(key: K, patch: Partial<NonNullable<NativeSettings[K]>>) => {
    const base = latestNativeSettingsRef.current;
    const section = ((base ?? nativeSettings)?.[key] ?? {}) as object;
    void saveNativeSettings({ ...currentSettings(), [key]: { ...section, ...patch } });
  }, [currentSettings, nativeSettings, saveNativeSettings]);

  const checkForAppUpdate = useCallback(async (force = false) => {
    if (appUpdatesDisabled) return;
    setCheckingAppUpdate(true);
    setAppUpdateMessage(null);
    try {
      await onRefreshAppUpdate(force);
    } catch (error) {
      setAppUpdateMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingAppUpdate(false);
    }
  }, [appUpdatesDisabled, onRefreshAppUpdate]);

  const currentTab = activeTab === "skills" ? activeTab : getNormalizedActive(activeTab);
  const nativeSettingsRequired = currentTab === "general" || currentTab === "models" || currentTab === "intelligence";
  useEffect(() => {
    if (currentTab === "system") {
      void fetchWindowsServiceStatus();
    }
  }, [currentTab, fetchWindowsServiceStatus]);


  const trimmedQuery = searchQuery.trim().toLowerCase();
  const searchActive = trimmedQuery.length > 0;

  const searchResults = useMemo<SearchResult[]>(() => {
    if (!trimmedQuery) return [];
    const results: SearchResult[] = [];
    for (const category of SETTINGS_CATEGORIES) {
      const labelKeyCat = `settingsTabs.${category.id}.label`;
      const descKeyCat = `settingsTabs.${category.id}.description`;
      const trLabelCat = t(labelKeyCat);
      const trDescCat = t(descKeyCat);
      const localizedLabel = trLabelCat !== labelKeyCat ? trLabelCat : category.label;
      const localizedDesc = trDescCat !== descKeyCat ? trDescCat : category.description;
      const haystack = `${localizedLabel} ${localizedDesc} ${category.label} ${category.description}`.toLowerCase();
      if (haystack.includes(trimmedQuery)) {
        results.push({ id: `tab-${category.id}`, kind: "category", tab: category.id, label: localizedLabel, description: localizedDesc });
      }
    }
    for (const setting of SETTING_INDEX) {
      const trLabel = t(setting.labelKey);
      const trDesc = t(setting.descKey);
      const trSection = t(setting.sectionKey);
      const localizedLabel = trLabel !== setting.labelKey ? trLabel : setting.fallbackLabel;
      const localizedDesc = trDesc !== setting.descKey ? trDesc : setting.fallbackDesc;
      const localizedSection = trSection !== setting.sectionKey ? trSection : setting.fallbackSection;
      const haystack = `${localizedLabel} ${localizedDesc} ${localizedSection} ${setting.fallbackLabel} ${setting.fallbackDesc} ${setting.fallbackSection}`.toLowerCase();
      if (haystack.includes(trimmedQuery)) {
        results.push({ id: setting.id, kind: "setting", tab: setting.tab, label: localizedLabel, description: localizedDesc, scope: setting.scope, section: localizedSection });
      }
    }
    return results;
  }, [trimmedQuery, t]);

  const openSearchResult = useCallback((result: SearchResult) => {
    startTransition(() => onSelectTab(result.tab));
    setHighlightId(result.kind === "setting" ? result.id : null);
    setSearchQuery("");
  }, [onSelectTab]);

  const handleSelectTab = useCallback((tab: SettingsTab) => {
    startTransition(() => onSelectTab(tab));
  }, [onSelectTab]);

  const contentStyle = useMemo(() => ({
    flex: 1 as const,
    minHeight: 0,
    display: "flex" as const,
    flexDirection: "column" as const,
    overflowY: "auto" as const,
    background: "var(--bg)" as const,
    opacity: isPending ? 0.92 : 1,
    transition: isPending ? "opacity 80ms ease-out" : "opacity 120ms ease-out",
  }), [isPending]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Keep Escape for clearing a filled field; a checkbox's DOM value is always "on".
        const target = e.target;
        if (target instanceof HTMLInputElement && target.type !== "checkbox" && target.value) return;
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="settings-view" role="region" aria-label={t("settingsConfig.title")}>
      <header className="settings-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            className="settings-back"
            onClick={onClose}
            aria-label={t("settingsConfig.back")}
            title={`${t("settingsConfig.back")} (Esc)`}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            <span>{t("settingsConfig.back")}</span>
          </button>
          <span style={{ width: 1, height: 18, background: "var(--border)", opacity: 0.8 }} aria-hidden="true" />
          <h1 style={{ fontSize: "var(--text-lg)", margin: 0, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--text)" }}>
            {t("settingsConfig.title")}
          </h1>
          {nativeSavesInFlight > 0 ? (
            <span className="settings-save-status" style={{ fontSize: "var(--text-xs)", color: "var(--accent)", padding: "2px 8px", borderRadius: 10, background: "var(--bg-subtle)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <RefreshCw size={11} className="spin" aria-hidden="true" /> {t("settingsConfig.saving")}
            </span>
          ) : nativeSettingsLoading ? (
            <span className="settings-save-status" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", padding: "2px 8px", borderRadius: 10, background: "var(--bg-subtle)" }}>
              {t("appShell.loading")}
            </span>
          ) : nativeSettingsError ? null : (
            <span className="settings-save-status" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", padding: "2px 8px", borderRadius: 10, background: "var(--bg-subtle)" }}>
              {t("settingsConfig.autoSaved")}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, maxWidth: 380, justifyContent: "flex-end" }}>
          <div style={{ position: "relative", width: "100%", maxWidth: 280 }}>
            <Search size={13} aria-hidden="true" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} />
            <input
              type="text"
              aria-label={t("settingsConfig.searchPlaceholder")}
              placeholder={t("settingsConfig.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (searchQuery) {
                    e.stopPropagation();
                    setSearchQuery("");
                    setHighlightId(null);
                  } else {
                    onClose();
                  }
                  (e.target as HTMLInputElement).blur();
                }
              }}
              style={{ width: "100%", height: "var(--row-height-compact)", padding: "0 28px 0 30px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: "var(--text-sm)", outline: "none" }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => { setSearchQuery(""); setHighlightId(null); }}
                style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2, display: "flex", alignItems: "center", justifyContent: "center" }}
                aria-label="Clear search"
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("settingsConfig.closeSettings")}
            title={`${t("settingsConfig.closeSettings")} (Esc)`}
            className="settings-close-btn ui-focus-ring"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="settings-body">
        {searchActive ? (
          <SearchResultsList results={searchResults} query={searchQuery.trim()} onSelect={openSearchResult} />
        ) : (
          <SettingsHighlightContext.Provider value={highlightId}>
            <SettingsTabs active={currentTab} onSelect={handleSelectTab} workspaceReady={workspaceReady} layout={isMobile ? "horizontal" : "vertical"} attentionTabs={attentionTabs} />

            <div className="settings-content" style={contentStyle}>
            {cluster && CLUSTER_CONFIG_TABS.includes(currentTab) && (
              <p style={{ flexShrink: 0, margin: isMobile ? "16px 14px 0" : "16px 24px 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settings.clusterConfigNotice")}</p>
            )}
            {nativeSettingsRequired && nativeSettingsLoading ? (
              <div className="settings-loading-state" role="status" aria-live="polite" aria-busy="true" aria-label={t("appShell.loading")}>
                <div className="skeleton settings-loading-row" />
                <div className="skeleton settings-loading-row" />
                <div className="skeleton settings-loading-row" />
              </div>
            ) : (
              <>
            {nativeSettingsRequired && nativeSettingsError && (
              <div style={{ margin: 16 }}>
                <Alert variant="error" description={nativeSettingsError} onDismiss={() => setNativeSettingsError(null)} />
              </div>
            )}
            {nativeSettingsRequired && nativeSettingsError && (
              <div style={{ margin: "0 16px 16px", display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => void loadNativeSettings()}
                  style={{ minHeight: "var(--control-height)", padding: "5px var(--control-padding-inline)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: 600 }}
                >
                  {t("chatWindow.retry")}
                </button>
              </div>
            )}

            {/* GENERAL & UI TAB */}
            {currentTab === "general" && (
              <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: "var(--text-2xl)", fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsConfig.interfaceBehavior")}</h2>
                  <p className="settings-content-subtitle" style={{ margin: "4px 0 16px", fontSize: "var(--text-md)", color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settingsConfig.interfaceBehaviorDesc")}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                  <NativeSetting searchId="keep-tool-calls-collapsed" label={t("settingsConfig.keepToolCallsCollapsed")} description={t("settingsConfig.keepToolCallsCollapsedDesc")} scope="UI">
                    <ToggleSwitch checked={toolCallsDefaultCollapsed} onChange={onToolCallsDefaultCollapsedChange} />
                  </NativeSetting>
                  <NativeSetting searchId="expand-thinking-by-default" label={t("settingsConfig.expandThinkingByDefault")} description={t("settingsConfig.expandThinkingByDefaultDesc")} scope="UI">
                    <ToggleSwitch checked={expandThinkingByDefault} onChange={onExpandThinkingByDefaultChange} />
                  </NativeSetting>
                  <NativeSetting searchId="hide-tool-activity" label={t("settingsConfig.hideToolActivity")} description={t("settingsConfig.hideToolActivityDesc")} scope="UI">
                    <ToggleSwitch checked={hideToolActivity} onChange={onHideToolActivityChange} />
                  </NativeSetting>
                  <NativeSetting searchId="show-tool-calls-unfolded" label={t("settingsConfig.showToolCallsUnfolded")} description={t("settingsConfig.showToolCallsUnfoldedDesc")} scope="UI">
                    <ToggleSwitch checked={showToolCallsUnfolded} onChange={onShowToolCallsUnfoldedChange} />
                  </NativeSetting>
                  <NativeSetting searchId="never-fold-activity" label={t("settingsConfig.neverFoldActivity")} description={t("settingsConfig.neverFoldActivityDesc")} scope="UI">
                    <ToggleSwitch checked={neverFoldActivity} onChange={onNeverFoldActivityChange} />
                  </NativeSetting>
                  <NativeSetting searchId="scope-native-select-all" label={t("settingsConfig.scopeNativeSelectAll")} description={t("settingsConfig.scopeNativeSelectAllDesc")} scope="UI">
                    <ToggleSwitch checked={scopeNativeSelectAll} onChange={onScopeNativeSelectAllChange} />
                  </NativeSetting>
                  <NativeSetting searchId="open-url-automatically" label={t("settingsConfig.openUrlAutomatically")} description={t("settingsConfig.openUrlAutomaticallyDesc")} scope="UI">
                    <ToggleSwitch checked={openUrlAutomatically} onChange={onOpenUrlAutomaticallyChange} />
                  </NativeSetting>
                  <NativeSetting searchId="completion-sound" label={t("settingsConfig.completionSound")} description={t("settingsConfig.completionSoundDesc")} scope="UI">
                    <ToggleSwitch
                      checked={soundEnabled}
                      onChange={(next) => {
                        setSoundEnabled(next);
                        try { localStorage.setItem("omp-sound-enabled", String(next)); } catch { /* storage fallback */ }
                        window.dispatchEvent(new CustomEvent("omp-sound-pref-change", { detail: next }));
                      }}
                    />
                  </NativeSetting>
                  <NativeSetting
                    searchId="tts-autoplay"
                    label={t("settingsConfig.ttsAutoplay") || "Auto-read assistant responses"}
                    description={ttsSupported ? (t("settingsConfig.ttsAutoplayDesc") || "Automatically read aloud new assistant replies when completed.") : `${t("settingsConfig.ttsAutoplayDesc") || "Automatically read aloud new assistant replies when completed."} (${t("settingsConfig.ttsNotSupported") || "Not supported in this browser"})`}
                    scope="UI"
                  >
                    <ToggleSwitch
                      checked={ttsSupported ? ttsAutoPlay : false}
                      disabled={!ttsSupported}
                      onChange={setTtsAutoPlay}
                    />
                  </NativeSetting>
                  <NativeSetting
                    searchId="tts-voice"
                    label={t("settingsConfig.ttsVoice") || "Speech Voice"}
                    description={ttsSupported ? (t("settingsConfig.ttsVoiceDesc") || "Select the browser voice for text-to-speech reading.") : `${t("settingsConfig.ttsVoiceDesc") || "Select the browser voice for text-to-speech reading."} (${t("settingsConfig.ttsNotSupported") || "Not supported in this browser"})`}
                    scope="UI"
                  >
                    <ThemedSelect
                      style={nativeSelectStyle}
                      value={ttsVoiceURI || ""}
                      disabled={!ttsSupported || ttsVoices.length === 0}
                      onChange={(nextValue) => setTtsVoiceURI(nextValue || null)}
                      options={[
                        { value: "", label: t("settingsConfig.defaultVoice") || "Default system voice" },
                        ...ttsVoices.map((v) => (({ value: v.voiceURI, label: <> {v.name} ({v.lang}) </> }))),
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="chat-font-size" label={t("settingsConfig.chatFontSize")} description={t("settingsConfig.chatFontSizeDesc")} scope="UI">
                    <ThemedSelect
                      style={nativeSelectStyle}
                      value={fontSize}
                      onChange={(nextValue) => setFontSize(nextValue as FontSizePreference)}
                      options={[
                        { value: "sm", label: t("settingsConfig.fontSizeSmall") },
                        { value: "md", label: t("settingsConfig.fontSizeMedium") },
                        { value: "lg", label: t("settingsConfig.fontSizeLarge") },
                        { value: "xl", label: t("settingsConfig.fontSizeXLarge") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="recent-runs-limit" label={t("settingsConfig.recentRunsLimit")} description={t("settingsConfig.recentRunsLimitDesc")} scope="UI">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <ThemedSelect
                        style={nativeSelectStyle}
                        value={recentRunsPreset}
                        onChange={(nextValue) => setRecentRunsPreset(nextValue as RecentRunsLimitPreset)}
                        options={[
                          { value: "10", label: t("settingsConfig.recentRunsOption10") },
                          { value: "15", label: t("settingsConfig.recentRunsOption15") },
                          { value: "20", label: t("settingsConfig.recentRunsOption20") },
                          { value: "custom", label: t("settingsConfig.recentRunsOptionCustom") },
                        ]}
                      />
                      {recentRunsPreset === "custom" && (
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={recentRunsCustomValue}
                          onChange={(e) => setRecentRunsCustomValue(Number(e.target.value))}
                          style={{
                            width: 80,
                            height: "var(--control-height)",
                            padding: "0 10px",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-control)",
                            background: "var(--bg)",
                            color: "var(--text)",
                            fontSize: "var(--text-sm)",
                          }}
                          placeholder={t("settingsConfig.recentRunsCustomPlaceholder")}
                        />
                      )}
                    </div>
                  </NativeSetting>
                  <NativeSetting searchId="ui-scale" label={t("settingsConfig.uiScale")} description={t("settingsConfig.uiScaleDesc")} scope="UI">
                    <ThemedSelect
                      style={nativeSelectStyle}
                      value={uiScale}
                      onChange={(nextValue) => setUiScale(nextValue as UiScalePreference)}
                      options={[
                        { value: "compact", label: t("settingsConfig.uiScaleCompact") },
                        { value: "standard", label: t("settingsConfig.uiScaleStandard") },
                        { value: "comfortable", label: t("settingsConfig.uiScaleComfortable") },
                        { value: "large", label: t("settingsConfig.uiScaleLarge") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="touch-targets" label={t("settingsConfig.touchTargets")} description={t("settingsConfig.touchTargetsDesc")} scope="UI">
                    <ThemedSelect
                      style={nativeSelectStyle}
                      value={touchTargets}
                      onChange={(nextValue) => setTouchTargets(nextValue as TouchTargetsPreference)}
                      options={[
                        { value: "auto", label: t("settingsConfig.touchTargetsAuto") },
                        { value: "compact", label: t("settingsConfig.touchTargetsCompact") },
                        { value: "accessible", label: t("settingsConfig.touchTargetsAccessible") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="message-during-active-run" label={t("settingsConfig.messageDuringActiveRun")} description={t("settingsConfig.messageDuringActiveRunDesc")} scope="UI">
                    <ThemedSelect
                      style={nativeSelectStyle}
                      value={submitBehavior}
                      onChange={(nextValue) => {
                        const next = nextValue as SubmitDuringRunBehavior;
                        setSubmitDuringRunBehavior(next);
                        setSubmitBehavior(next);
                      }}
                      options={[
                        { value: "steer", label: t("settingsConfig.steerCurrentRun") },
                        { value: "queue", label: t("settingsConfig.queueFollowUp") },
                      ]}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="connection-diagnostics" label={t("settingsConfig.connectionDiagnostics")} description={t("settingsConfig.connectionDiagnosticsDesc")} scope="UI">
                    <ToggleSwitch checked={connectionDiagnostics} onChange={setConnectionDiagnosticsEnabled} />
                  </NativeSetting>
                </div>
              </div>
            )}

            {/* AI MODEL DEFAULTS TAB */}
            {currentTab === "models" && (
              <div role="tabpanel" id="settings-panel-models" aria-labelledby="settings-tab-models" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: "var(--text-2xl)", fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsConfig.modelDefaults")}</h2>
                  <p className="settings-content-subtitle" style={{ margin: "4px 0 16px", fontSize: "var(--text-md)", color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settingsConfig.modelDefaultsDesc")}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                  <NativeSetting searchId="reasoning" label={t("settingsConfig.reasoning")} description={t("settingsConfig.reasoningDesc")} scope="Native OMP">
                    <ThemedSelect
                      style={nativeSelectStyle}
                      value={nativeSettings?.defaultThinkingLevel ?? "medium"}
                      onChange={(nextValue) => patchSettings({ defaultThinkingLevel: nextValue as NativeSettings["defaultThinkingLevel"] })}
                      options={["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (({ value: l, label: l })))}
                    />
                  </NativeSetting>
                  <NativeSetting searchId="thinking-blocks" label={t("settingsConfig.thinkingBlocks")} description={t("settingsConfig.thinkingBlocksDesc")} scope="Native OMP">
                    <ToggleSwitch
                      checked={nativeSettings?.hideThinkingBlock ?? false}
                      onChange={(checked) => { patchSettings({ hideThinkingBlock: checked }); onHideThinkingBlockChange?.(checked); }}
                    />
                  </NativeSetting>
                </div>
              </div>
            )}

            {/* API KEYS & PROVIDERS TAB */}
            {currentTab === "providers" && (
              <div role="tabpanel" id="settings-panel-providers" aria-labelledby="settings-tab-providers" className="settings-panel-inner" style={{ display: currentTab === "providers" ? "flex" : "none", width: "100%", maxWidth: 940, minHeight: 0, flexDirection: "column", padding: isMobile ? "16px 14px 32px" : "32px 24px 64px" }}>
                <div style={{ marginBottom: 12 }}>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsTabs.providers.label")}</h2>
                  <p className="settings-content-subtitle" style={{ margin: "4px 0 16px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settingsTabs.providers.description")}</p>
                </div>
                <ModelsConfig embedded onClose={onClose} onSaved={onModelsSaved} />
              </div>
            )}

            {/* USAGE & ANALYTICS TAB */}
            {currentTab === "usage" && (
              <div
                role="tabpanel"
                id="settings-panel-usage"
                aria-labelledby="settings-tab-usage"
                className="settings-panel-inner"
                style={{
                  display: currentTab === "usage" ? "flex" : "none",
                  width: "100%",
                  maxWidth: 940,
                  minHeight: 0,
                  flexDirection: "column",
                  padding: isMobile ? "16px 14px 32px" : "32px 24px 64px",
                }}
              >
                <UsageConfig />
              </div>
            )}

            {/* AGENT INTELLIGENCE TAB */}
            {currentTab === "intelligence" && (
              <div role="tabpanel" id="settings-panel-intelligence" aria-labelledby="settings-tab-intelligence" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 20 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsTabs.intelligence.label")}</h2>
                  <p className="settings-content-subtitle" style={{ margin: "4px 0 16px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settingsTabs.intelligence.description")}</p>
                </div>
                {/* Context Compaction Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 18, width: "100%" }}>
                  <div className="settings-section-title" style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{t("settingsConfig.contextCompaction")}</div>
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12.5, lineHeight: 1.45 }}>{t("settingsConfig.contextCompactionDesc")}</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4, width: "100%" }}>
                    <NativeSetting searchId="automatic-compaction" label={t("settingsConfig.automaticCompaction")} description={t("settingsConfig.automaticCompactionDesc")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.compaction?.enabled ?? true}
                        onChange={(checked) => patchSection("compaction", { enabled: checked })}
                      />
                    </NativeSetting>
                  </div>
                </section>

                {/* Retry Section */}
                <section style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 18, width: "100%" }}>
                  <div className="settings-section-title" style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{t("settingsConfig.automaticRetry")}</div>
                  <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12.5, lineHeight: 1.45 }}>{t("settingsConfig.automaticRetryDesc")}</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4, width: "100%" }}>
                    <NativeSetting searchId="automatic-retry" label={t("settingsConfig.retryToggle")} description={t("settingsConfig.retryToggleDesc")} scope="Native OMP">
                      <ToggleSwitch
                        checked={nativeSettings?.retry?.enabled ?? true}
                        onChange={(checked) => patchSection("retry", { enabled: checked })}
                      />
                    </NativeSetting>
                    <NativeSetting searchId="max-attempts" label={t("settingsConfig.maxAttempts")} description={t("settingsConfig.maxAttemptsDesc")} scope="Native OMP">
                      <ThemedSelect
                        style={nativeSelectStyle}
                        value={String(nativeSettings?.retry?.maxRetries ?? 3)}
                        onChange={(nextValue) => patchSection("retry", { maxRetries: Number(nextValue) })}
                        options={[0, 1, 2, 3, 4, 5].map((n) => (({ value: n, label: n })))}
                      />
                    </NativeSetting>
                  </div>
                </section>
              </div>
            )}

            {/* EXTENSIONS & TOOLS TAB (MCP, SKILLS, PLUGINS) */}
            {currentTab === "mcp" && (
              <div role="tabpanel" id="settings-panel-mcp" aria-labelledby="settings-tab-mcp" className="settings-panel-inner" style={{ display: currentTab === "mcp" ? "flex" : "none", width: "100%", maxWidth: 940, minHeight: 0, flexDirection: "column", padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsConfig.extensionsTools")}</h2>
                  <p className="settings-content-subtitle" style={{ margin: "4px 0 16px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settingsConfig.extensionsToolsDesc")}</p>
                  {cwd && (!remoteHost || cluster) && <button type="button" className="settings-back ui-focus-ring" onClick={() => handleSelectTab("skills")}>{t("skillsConfig.title")}</button>}
                </div>
                {panelsUnavailable ? remoteUnavailable : <McpConfig cwd={panelCwd} />}
                {!cwd && <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>{t("settingsConfig.selectWorkspaceForMcp")}</p>}
              </div>
            )}

            {/* SKILLS SUB-PANEL CONTRACT MATCH */}
            {cwd && currentTab === "skills" && (
              <div role="tabpanel" id="settings-panel-skills" aria-labelledby="settings-tab-mcp" className="settings-panel-inner" style={{ display: currentTab === "skills" ? "flex" : "none", width: "100%", maxWidth: 940, minHeight: isMobile ? undefined : 600, flexDirection: "column", padding: isMobile ? "16px 14px 32px" : "32px 24px 64px" }}>
                {panelsUnavailable ? remoteUnavailable : <SkillsConfig embedded cwd={panelCwd} onClose={onClose} />}
              </div>
            )}

            {/* PLUGINS SUB-PANEL CONTRACT MATCH */}
            {cwd && currentTab === "plugins" && (
              <div role="tabpanel" id="settings-panel-plugins" aria-labelledby="settings-tab-plugins" className="settings-panel-inner" style={{ display: currentTab === "plugins" ? "flex" : "none", width: "100%", maxWidth: 940, minHeight: isMobile ? undefined : 600, flexDirection: "column", padding: isMobile ? "16px 14px 32px" : "32px 24px 64px" }}>
                {panelsUnavailable ? remoteUnavailable : <PluginsConfig embedded cwd={panelCwd} sessionId={panelSessionId} onClose={onClose} onReloaded={onPluginsReloaded} />}
              </div>
            )}

            {/* HOSTS TAB */}
            {currentTab === "hosts" && (
              <div role="tabpanel" id="settings-panel-hosts" aria-labelledby="settings-tab-hosts" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("hostsConfig.title")}</h2>
                </div>
                <HostsConfig />
              </div>
            )}

            {/* NOTIFICATIONS TAB */}
            {currentTab === "notifications" && (
              <div role="tabpanel" id="settings-panel-notifications" aria-labelledby="settings-tab-notifications" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", gap: 16 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: "var(--text-2xl)", fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("notifications.title")}</h2>
                  <p className="settings-content-subtitle" style={{ margin: "4px 0 16px", fontSize: "var(--text-md)", color: "var(--text-muted)", lineHeight: 1.45 }}>{t("notifications.subtitle")}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                  <NotificationSettingsPanel />
                </div>
              </div>
            )}

            {/* SYSTEM TAB */}
            {currentTab === "system" && (
              <div role="tabpanel" id="settings-panel-system" aria-labelledby="settings-tab-system" className="settings-panel-inner" style={{ padding: isMobile ? "16px 14px 32px" : "32px 24px 64px", display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={{ marginBottom: 4 }}>
                  <h2 className="display-serif" style={{ fontSize: 22, fontWeight: 600, margin: 0, color: "var(--text)", letterSpacing: "-0.01em" }}>{t("settingsConfig.systemUpdates")}</h2>
                  <p className="settings-content-subtitle" style={{ margin: "4px 0 16px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.45 }}>{t("settingsConfig.systemUpdatesDescription")}</p>
                </div>

                <AutoResumeSessionsSetting />

                <AgentToolsSetting />

                <GithubWritesSetting />

                <GithubActionsPermissionsSetting />

                <UploadRetentionSetting />

                <AgentEnvSetting cluster={cluster} />

                {/* tau app update card */}
                <section style={{ padding: 14, border: appUpdateIsAvailable ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))" : "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{t("settingsConfig.appLabel")}</span>
                        {appUpdateIsAvailable && (
                          <span
                            role="status"
                            aria-label={t("settingsTabs.updateAvailable")}
                            title={t("settingsTabs.updateAvailable")}
                            style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }}
                          />
                        )}
                      </div>
                      <div style={{ marginTop: 4, color: appUpdateIsAvailable ? "var(--accent)" : "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {appUpdatesDisabled ? t("settingsConfig.updatesDisabled") : checkingAppUpdate ? t("settingsConfig.checkingUpdates") : appUpdate?.updateAvailable ? t("appShell.updateVersion", { current: appUpdate.currentVersion ?? "?", available: appUpdate.availableVersion ?? "?" }) : appUpdate?.currentVersion ? t("settingsConfig.upToDate", { version: appUpdate.currentVersion }) : t("settingsConfig.versionUnavailable")}
                      </div>
                    </div>
                    <button type="button" onClick={() => void checkForAppUpdate(true)} disabled={checkingAppUpdate || appUpdatesDisabled} aria-label={t("settingsConfig.checkAppUpdates")} style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: checkingAppUpdate || appUpdatesDisabled ? "not-allowed" : "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <RefreshCw size={13} aria-hidden="true" /> {t("settingsConfig.refresh")}
                    </button>
                  </div>
                  {appUpdate?.updateAvailable && (
                    <div style={{ marginTop: 6, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", display: "flex", flexDirection: "column", gap: 8 }}>
                      {appUpdate.selfUpdateSupported ? (
                        <button
                          type="button"
                          onClick={onRequestAppUpdate}
                          style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                        >
                          <Download size={13} aria-hidden="true" />
                          {t("settingsConfig.appUpdateAction")}
                        </button>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {t(appUpdate.installMethod === "binary" ? "settingsConfig.downloadAppUpdate" : "settingsConfig.runAppUpdateCommand")}
                          </div>
                          {appUpdate.installMethod === "binary" ? (
                            <a href={appUpdate.updateCommand} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)", wordBreak: "break-all" }}>{appUpdate.updateCommand}</a>
                          ) : (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <code style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)", wordBreak: "break-all" }}>{appUpdate.updateCommand || "npm install -g @ompweb-dev/tau"}</code>
                              <button
                                type="button"
                                onClick={() => {
                                  void copyText(appUpdate.updateCommand || "npm install -g @ompweb-dev/tau")
                                    .then(() => toast.success(t("appShell.commandCopied")))
                                    .catch(() => toast.error(t("appShell.commandCopyFailed")));
                                }}
                                style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
                              >
                                <Copy size={12} aria-hidden="true" /> {t("appShell.copyCommand")}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {appUpdateMessage && <Alert variant={appUpdateMessage.toLowerCase().includes("fail") || appUpdateMessage.toLowerCase().includes("error") ? "error" : "info"} description={appUpdateMessage} onDismiss={() => setAppUpdateMessage(null)} />}
                </section>

                {/* Windows Background Service & System Tray card (Windows only) */}
                {windowsService?.isWindows && (
                  <section style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                          <Monitor size={15} aria-hidden="true" />
                          {t("settingsConfig.windowsServiceTitle")}
                        </div>
                        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.4 }}>
                          {t("settingsConfig.windowsServiceDesc")}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void fetchWindowsServiceStatus()}
                        disabled={loadingWindowsService}
                        aria-label={t("settingsConfig.refresh")}
                        style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: loadingWindowsService ? "wait" : "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}
                      >
                        <RefreshCw size={13} aria-hidden="true" /> {t("settingsConfig.refresh")}
                      </button>
                    </div>

                    {/* Status badges grid */}
                    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                      <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          {t("settingsConfig.windowsServiceStatus")}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, color: windowsService.isRunning ? "var(--accent)" : "var(--text-muted)" }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: windowsService.isRunning ? "var(--accent)" : "var(--border)" }} />
                          {windowsService.isRunning ? t("settingsConfig.windowsServiceRunning", { port: windowsService.port }) : t("settingsConfig.windowsServiceStopped")}
                        </div>
                      </div>

                      <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          {t("settingsConfig.windowsServiceDesktopShortcut", { status: "" }).replace(/:\s*$/, "")}
                        </div>
                        <div style={{ fontSize: 12, color: windowsService.desktopShortcutExists ? "var(--text)" : "var(--text-muted)" }}>
                          {windowsService.desktopShortcutExists ? t("settingsConfig.windowsServicePresent") : t("settingsConfig.windowsServiceMissing")}
                        </div>
                      </div>
                    </div>

                    {/* Autostart Toggle */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{t("settingsConfig.windowsServiceAutostart")}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("settingsConfig.windowsServiceAutostartDesc")}</div>
                      </div>
                      <ToggleSwitch
                        id="windows-service-autostart-toggle"
                        checked={windowsService.autostart}
                        disabled={windowsServiceActionPending}
                        onChange={(checked) => void performWindowsServiceAction("toggle-autostart", { autostart: checked })}
                      />
                    </div>

                    {/* Action buttons toolbar */}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => void performWindowsServiceAction("install", { startImmediately: false })}
                        disabled={windowsServiceActionPending}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                      >
                        <Monitor size={13} aria-hidden="true" />
                        {windowsService.isInstalled ? t("settingsConfig.windowsServiceReinstallBtn") : t("settingsConfig.windowsServiceInstallBtn")}
                      </button>

                      {windowsService.isRunning ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void performWindowsServiceAction("restart")}
                            disabled={windowsServiceActionPending}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                          >
                            <RotateCcw size={13} aria-hidden="true" /> {t("settingsConfig.windowsServiceRestartBtn")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void performWindowsServiceAction("stop")}
                            disabled={windowsServiceActionPending}
                            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                          >
                            <Square size={13} aria-hidden="true" /> {t("settingsConfig.windowsServiceStopBtn")}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void performWindowsServiceAction("start")}
                          disabled={windowsServiceActionPending}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                        >
                          <Play size={13} aria-hidden="true" /> {t("settingsConfig.windowsServiceStartBtn")}
                        </button>
                      )}

                      {windowsService.isInstalled && (
                        <button
                          type="button"
                          onClick={() => void performWindowsServiceAction("uninstall", { cleanConfig: false })}
                          disabled={windowsServiceActionPending}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: windowsServiceActionPending ? "wait" : "pointer", fontSize: 12 }}
                        >
                          <Trash2 size={13} aria-hidden="true" /> {t("settingsConfig.windowsServiceUninstallBtn")}
                        </button>
                      )}
                    </div>
                    {message && <Alert variant={message.toLowerCase().includes("fail") || message.toLowerCase().includes("error") ? "error" : "info"} description={message} onDismiss={() => setMessage(null)} />}
                  </section>
                )}
              </div>
            )}
              </>
            )}
              </div>
            </SettingsHighlightContext.Provider>
          )}
        </div>
      </div>
  );
}
