// Types mirrored from pi's session entries (core/session-manager, v3 format).
import type { RpcAskDialogQuestion, TodoPhase } from "./pi-types";
import type { MessageOrigin, SessionOriginRef } from "./message-origin";

// tau never imports pi's SDK, so the on-disk
// shapes are re-declared here. Legacy pi v1/v2 fields are kept optional.

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  /** The session name (latest session_info), set by loadSessionFile; never stored in the header. */
  title?: string;
  timestamp: string;
  cwd: string;
  /** Extra workspace roots beyond cwd (multi-root workspace). */
  additionalDirectories?: string[];
  parentSession?: string;
  providerPromptCacheKey?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** Client intent metadata stored on native message/custom-message entries, never sent to the model. */
  clientMessageId?: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

/**
 * Image block. pi persists the flat {data, mimeType} shape; legacy entries used the nested
 * Anthropic-style `source` shape. The UI handles both. Tool-result images
 * reach the browser as `url` (`/api/media/<sha256>`, `?thumb=1` for a small
 * preview) instead of inline base64.
 */
export interface ImageContent {
  type: "image";
  data?: string;
  mimeType?: string;
  url?: string;
  source?: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Historical content omitted from the initial response and loaded on demand. */
  deferred?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
  clientMessageId?: string;
  /** Rendered from a `branch_summary` entry, not a real prompt: pi cannot fork at it. */
  branchSummary?: true;
  /** Server-authored provenance, stored outside the native message entry and never supplied by browser commands. */
  origin?: MessageOrigin;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens?: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
  /** Live snapshot of a tool that is still executing (pi's
   * `tool_execution_update`), not a committed result. Rendering treats it as
   * "running" and keeps it out of the session's toolResult list. */
  partial?: boolean;
  /** Sanitized one-line passive context emitted after this result's tool
   * batch (`collectToolResults`); display-only, never part of the result. */
  passiveContext?: string;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
  clientMessageId?: string;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

/** System-slot instruction message (steering envelopes, file-mention text). */
export interface DeveloperMessage {
  role: "developer";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

/** User-initiated Python execution via the $ command (pi writes none). */
export interface PythonExecutionMessage {
  role: "pythonExecution";
  code: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean;
  timestamp?: number;
}

/** Auto-read @filepath mentions packed into a single message (pi writes none). */
export interface FileMentionMessage {
  role: "fileMention";
  files: Array<{
    path: string;
    content: string;
    lineCount?: number;
    byteSize?: number;
    skippedReason?: "tooLarge" | "binary";
    image?: ImageContent;
  }>;
  timestamp?: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage
  | BashExecutionMessage
  | DeveloperMessage
  | PythonExecutionMessage
  | FileMentionMessage;

/** Dialog options as a `ui_request` carries them (no signal or callbacks). */
export interface UiDialogOptions {
  timeout?: number;
  /** `input`: mask the entered text. */
  secret?: boolean;
  /** Checkbox list (ask multi-select): `checkedIndices` is the authoritative checked state. */
  selectionMarker?: "radio" | "checkbox";
  checkedIndices?: number[];
  /** Leading options that get a marker; the rest are actions such as Other and Done. */
  markableCount?: number;
}

// JSON turns an omitted middle argument into null.
type UiDialogOptionsArg = UiDialogOptions | null;

export type UiSelectItem = string | { label: string; description?: string };

/** An ask dialog's submit result. */
export interface UiAskDialogResult {
  kind: "submit";
  results: {
    id: string;
    question: string;
    options: string[];
    multi: boolean;
    selectedOptions: string[];
    customInput?: string;
  }[];
}

export type AgentConfirmPayload =
  | {
      kind: "send_to_session";
      from: SessionOriginRef;
      to: SessionOriginRef | null;
      delivery: "prompt" | "steer" | "followUp";
      message: string;
    }
  | {
      kind: "new_session";
      from: SessionOriginRef;
      host: { id: string; label: string };
      cwd: string;
      name: string | null;
      message: string | null;
    };

/** What a dialog method returns; a cancel sends no value. */
export type UiDialogValue = string | boolean | UiAskDialogResult;

/**
 * A dialog pi opened: `method` is its `ExtensionUIContext` method (or tau's own `askDialog`
 * for its ask tool), `args` its positional
 * arguments. tau's own confirms carry string ids. `expiresAt` (epoch ms) is set when it times out.
 */
export type UiDialogRequest = { type: "ui_request"; id: number | string; expiresAt?: number } & (
  | { method: "select"; args: [title: string, options: UiSelectItem[], dialogOptions?: UiDialogOptionsArg] }
  | { method: "confirm"; args: [title: string, message: string, dialogOptions?: UiDialogOptionsArg]; serverPayload?: AgentConfirmPayload }
  | { method: "input"; args: [title: string, placeholder?: string | null, dialogOptions?: UiDialogOptionsArg] }
  | {
      method: "editor";
      args: [title: string, prefill?: string | null, dialogOptions?: UiDialogOptionsArg, editorOptions?: { promptStyle?: boolean } | null];
    }
  | { method: "askDialog"; args: [questions: RpcAskDialogQuestion[], dialogOptions?: UiDialogOptionsArg] }
);

/** A presentation call from pi (`extension_ui_request`); `notify` arrives as a `notice` frame instead. */
export type UiPresentationFrame = { type: "ui" } & (
  | { method: "setStatus"; statusKey: string; statusText?: string }
  | { method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { method: "setTitle"; title: string }
  | { method: "set_editor_text"; text: string }
);

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel?: string | null;
  /** Configured selector ("auto" or a concrete level); absent on old entries. */
  configured?: string | null;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  /** Single-string form "provider/modelId" (pi writes `provider` and `modelId`). */
  model?: string;
  /** Model role ("default", "smol", ...); undefined means "default". */
  role?: string;
  /** Legacy pi format kept for pre-migration files. */
  provider?: string;
  modelId?: string;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
  type: "service_tier_change";
  serviceTier: unknown;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

/** pi's session name entry (appendSessionInfo); the latest one names the session, an empty name clears it. */
export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

/** Tracks which time-traveling rules have been injected this session (pi writes none). */
export interface TtsrInjectionEntry extends SessionEntryBase {
  type: "ttsr_injection";
  injectedRules: string[];
}

/** Initial context capture for subagent sessions (pi writes none). */
export interface SessionInitEntry extends SessionEntryBase {
  type: "session_init";
  systemPrompt: string;
  task: string;
  tools: string[];
  outputSchema?: unknown;
  outputSchemaMode?: string;
  restrictToolNames?: boolean;
  spawns?: string;
  readSummarize?: boolean;
}

/** Agent mode transitions, e.g. plan mode (pi writes none). */
export interface ModeChangeEntry extends SessionEntryBase {
  type: "mode_change";
  /** Current mode name, or "none" when exiting a mode. */
  mode: string;
  data?: Record<string, unknown>;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | ServiceTierChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry
  | TtsrInjectionEntry
  | SessionInitEntry
  | ModeChangeEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface BranchPreview {
  role?: "user" | "assistant";
  text: string;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
  branchPreview?: BranchPreview;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  /** ISO time of the last message entry (absent when the tail scan found none). */
  lastMessageAt?: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string; // set if this session was forked from another
  /** Main repo root shared by all worktrees of this cwd (cwd itself for non-git dirs).
   *  Always set by the server; optional because the client builds transient
   *  SessionInfo objects before the first refresh. Fall back to cwd. */
  projectRoot?: string;
  /** Stable identity key for grouping and comparison (case-folded on Windows). */
  projectKey?: string;
  /** Branch name when cwd is a linked git worktree (not the main checkout) */
  worktreeBranch?: string;
  /** Host the session's file lives on ("local" for this machine). Set by the
   *  all-hosts session list; a host's own list leaves it out. */
  hostId?: string;
  /** Registered logical identity; physical owner/cwd/projectRoot remain unchanged. */
  poolId?: string;
  projectId?: string;
}

/** Metadata for a gzip-compressed session in the archive tree. */
export interface ArchivedSessionInfo {
  key: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  archivedAt: string;
  messageCount: number;
  firstMessage: string;
  size: number;
  status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
  /** In-progress/interrupted restore evidence; its unique capture key is not an actionable restore target. */
  restorePending?: true;
  /** Host whose archive holds it ("local" for this machine). Set by the all-hosts list; a host's own list leaves it out. */
  hostId?: string;
}

/** Workspace-level pi launch configuration; only affects pi children spawned for that workspace. */
export interface ProjectLaunchConfig {
  /** Extra pi CLI args, stored as an array. */
  extraArgs?: string[];
}

/** A project in the sidebar: an explicitly added directory (registered in the
 *  on-disk registry) or one discovered from existing sessions. Paths are the
 *  canonical projectRoot — worktrees resolve to their main repository. */
export interface ManagedProject {
  path: string;
  /** ISO timestamp of the last explicit add. */
  addedAt?: string;
  /** User-defined display name; never changes the directory path. */
  alias?: string;
  /** Explicit sidebar position for registered projects. */
  sortOrder?: number;
  /** Set when pinned: position among pinned workspaces (lower first). Pins
   *  only apply while the sidebar sorts by name or activity. */
  pinOrder?: number;
  /** Workspace-level pi launch configuration. */
  launchConfig?: ProjectLaunchConfig;
  /** Host the project lives on ("local" for this machine). Set by GET /api/projects. */
  hostId?: string;
  /** Logical pool target; path/hostId, when present, are diagnostic only. */
  poolId?: string;
  projectId?: string;
  projectKey?: string;
  origin?: string;
  name?: string;
  defaultRef?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[]; // parallel to messages — the session entry id for each message
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  /** Latest persisted todo snapshot on the selected session branch. */
  todoPhases: TodoPhase[];
  /** Correlated native messages retained in the session's append history, including compacted entries. */
  persistedClientMessageIds?: string[];
  /** Explicit native withdrawals/consumption records; absence alone never resolves a handoff. */
  resolvedClientMessageIds?: string[];
}

/** A host tool call for a session no tab is watching, sent to every open tab. */
export interface CrossSessionHostToolCall {
  sessionId: string;
  hostId: string;
  cwd: string;
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type CrossSessionHostToolEvent = (CrossSessionHostToolCall & { type?: "host_tool_call" }) | {
  type: "host_tool_cancel";
  sessionId: string;
  hostId: string;
  targetId: string;
};

/** A pi child that exited unexpectedly; retained until that session starts again. */
export interface ExitedRpcSession {
  id: string;
  cwd: string;
  /** Absent on this machine, as on `SessionInfo`. */
  hostId?: string;
  at: number;
  code: number | null;
  signal: string | null;
  /** Last stderr line, if any. */
  detail: string;
}

/** How a held message goes to pi (docs/specs/2026-11-04-message-outbox-design.md O3). */
export type OutboxMode = "prompt" | "followUp" | "steer";

/** A message tau holds for a session until pi has it (the web server's outbox, lib/message-outbox.ts). */
export interface OutboxEntry {
  id: string;
  sessionId: string;
  /** The session's host ("local" for this machine): the same id on another host is another session's outbox. */
  hostId: string;
  mode: OutboxMode;
  message: string;
  images?: { type: "image"; data: string; mimeType: string }[];
  uploads?: string[];
  origin?: MessageOrigin;
  state: "held" | "waiting_host" | "delivering" | "failed" | "delivered";
  error?: string;
  /** A lost reply: pi may have it; never resent by itself. */
  mayHaveBeenSent?: boolean;
  /** Only while delivering: authoritative persisted history captured before dispatch, never retained in tombstones. */
  previousEntryIds?: string[];
  /** Delivered native input still needs its correlated view; none is an explicit non-message completion. */
  settlement?: "native" | "none" | "uncorrelated";
  createdAt: number;
}

/** The session channel's outbox snapshot: every entry not yet delivered, in submission order. */
export interface OutboxUpdateFrame {
  type: "outbox_update";
  entries: OutboxEntry[];
  /** Recent delivered/removed ids: a late first subscription can retire browser copies without seeing their removal. */
  settledIds: string[];
  nativeSettledIds?: string[];
}
