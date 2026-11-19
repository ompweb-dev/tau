import type { AgentMessage } from "./types";
import type { MessageOrigin } from "./message-origin";

// Local mirrors of the pi RPC shapes used by tau, hand-maintained against
// pi's modes/rpc/rpc-types.d.ts (tau never imports pi's SDK). tau's own
// additions come from lib/pi/tau-extension.ts and lib/pi/rpc-process.ts.

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

/** Subset of pi's Model (pi-ai) that the web UI reads; extra fields pass through. */
export interface PiModel {
  id: string;
  provider: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  thinking?: {
    mode?: string;
    efforts?: string[];
    requiresEffort?: boolean;
    defaultLevel?: string;
  };
  [key: string]: unknown;
}

export interface TodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "abandoned";
  blocker?: string;
}

export interface TodoPhase {
  id?: string;
  name: string;
  tasks: TodoItem[];
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
  /** Native intent IDs aligned with the visible queue slots; null denotes an older uncorrelated message. */
  clientMessageIds?: { steering: (string | null)[]; followUp: (string | null)[] };
  /** Trusted origins aligned with the visible queue slots; null denotes an ordinary message. */
  messageOrigins?: { steering: (MessageOrigin | null)[]; followUp: (MessageOrigin | null)[] };
}

export interface ClientMessageStatus {
  messages: { clientMessageId: string; message: AgentMessage }[];
  /** Null when the native queue snapshot exceeded the response budget; the browser then reads history. */
  queuedMessages: QueuedMessages | null;
  resolvedClientMessageIds: string[];
  persistedClientMessageIds: string[];
  unresolvedClientMessageIds: string[];
}

/** Mirror of pi's RpcSessionState (the raw `get_state` payload). */
export interface RpcSessionState {
  model?: PiModel;
  thinkingLevel: string | undefined;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  autoRetryEnabled?: boolean;
  messageCount: number;
  queuedMessageCount: number;
  /** Includes admitted submissions, scheduled turns and background deliveries (RpcProcess derives it from pi's `agent_settled`). */
  isSettled?: boolean;
  hasPendingAsyncWork?: boolean;
  /** Displayable queue-chip texts, from pi's last `queue_update` (RpcProcess fills them into `get_state`). */
  queuedMessages?: QueuedMessages;
  /** Native RPC/session metadata can correlate accepted input without matching its text. */
  supportsClientMessageIds?: boolean;
  todoPhases: TodoPhase[];
  systemPrompt?: string[];
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
}

/**
 * The state shape tau's own API returns to the browser
 * (AgentSessionWrapper adapts RpcSessionState and adds process-side flags).
 */
export interface WebSessionState {
  sessionId: string;
  sessionFile: string;
  sessionName?: string;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  /** Web-observed current-run response; not a persisted-history cursor. */
  responseObserved?: boolean;
  autoCompactionEnabled: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  model?: ModelLike & { name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } };
  messageCount: number;
  queuedMessageCount: number;
  queuedMessages: QueuedMessages;
  supportsClientMessageIds?: boolean;
  contextUsage: ContextUsage | null;
  systemPrompt: string;
  thinkingLevel: string;
  autoRetryEnabled?: boolean;
  todoPhases: TodoPhase[];
  extensionStatuses: Array<{ key: string; text: string }>;
  extensionWidgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}

export type AvailableSlashCommandSource =
  | "builtin"
  | "skill"
  | "extension"
  | "custom"
  | "mcp_prompt"
  | "file";

/** One slash command as `get_available_commands` returns it (pi's `get_commands`, lib/pi/rpc-process.ts). */
export interface RpcAvailableSlashCommand {
  name: string;
  aliases?: string[];
  description?: string;
  input?: { hint?: string };
  subcommands?: Array<{ name: string; description?: string; usage?: string }>;
  source: AvailableSlashCommandSource;
}

/** Mirror of pi's BashResult (`bash` command response). */
export interface BashResultInfo {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  timedOut?: boolean;
  truncated: boolean;
  totalLines?: number;
  totalBytes?: number;
  outputLines?: number;
  outputBytes?: number;
  artifactId?: string;
  workingDir?: string;
  /** tau: pi held the result back for the next prompt (a turn was running). */
  deferred?: boolean;
}

export interface GenerationSpeedInfo {
  average: number | null;
}

export interface SessionStatsInfo {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  premiumRequests?: number;
  cost: number;
  contextUsage?: ContextUsage;
}

/** One question of an ask dialog (`method: "askDialog"`). */
export interface RpcAskDialogQuestion {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi?: boolean;
  /** Index into `options`. */
  recommended?: number;
}

/** Per-question answer, sent back in question order. */
export interface RpcAskDialogAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

/**
 * A submitted whole-form ask (`formDialog`), by control `name`: radios, single checkboxes and
 * single selects give their value (omitted when nothing is chosen), checkbox groups and multi-selects
 * an array, `number`/`range` inputs a number, other text fields their text. Mirrors pi-tui's html-form.
 */
export type HtmlFormData = Record<string, string | number | string[]>;

/**
 * tau's host-tool bridge: tau registers host tools (set_host_tools, which the
 * daemon hands to the extension's `/tau_host_tools`) that the agent can call;
 * the server emits host_tool_call frames the UI executes, and the UI answers
 * with host_tool_result.
 */
export interface HostToolParameter {
  type?: string;
  description?: string;
  [key: string]: unknown;
}

export interface HostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
  loadMode?: "always" | "discoverable" | "explicit";
}

export interface HostToolCallFrame {
  type: "host_tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface HostToolCancelFrame {
  type: "host_tool_cancel";
  id: string;
  targetId: string;
}

export interface HostToolResultFrame {
  type: "host_tool_result";
  id: string;
  result: unknown;
  isError?: boolean;
}

/**
 * Host-URI bridge: the host registers URL schemes (set_host_uri_schemes)
 * that the agent's read/write tools resolve through the UI; the server emits
 * host_uri_request frames the UI satisfies with host_uri_result. pi has no
 * counterpart: the daemon drops the registration (lib/hosts/daemon-channels.ts).
 */
export interface HostUriSchemeDefinition {
  scheme: string;
  description?: string;
  writable?: boolean;
  immutable?: boolean;
}

export type HostUriOperation = "read" | "write";

export interface HostUriRequestFrame {
  type: "host_uri_request";
  id: string;
  operation: HostUriOperation;
  url: string;
  /** Present for write operations. */
  content?: string;
}

export interface HostUriCancelFrame {
  type: "host_uri_cancel";
  id: string;
  targetId: string;
}

export interface HostUriResultFrame {
  type: "host_uri_result";
  id: string;
  content?: string;
  contentType?: "text/markdown" | "application/json" | "text/plain";
  isError?: boolean;
  error?: string;
}
