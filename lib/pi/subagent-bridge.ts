import { isRecord } from "../type-guards";

/**
 * pi-subagents (the pi package that runs subagents) reports its children two ways an RPC host can read: foreground
 * runs as progress on its `subagent` tool call (`details.progress[]`, AgentProgress rows), and background runs as
 * `PI_SUBAGENT_ASYNC_JSON:` snapshots on its `subagent-async` widget. SubagentBridge turns both into the
 * `subagent_lifecycle` / `subagent_progress` frames tau's roster reads, and keeps the running children for
 * `get_subagents`.
 */

type Frame = { type: string; [key: string]: unknown };
type Status = "started" | "completed" | "failed" | "aborted";
type ProgressStatus = "pending" | "running" | "completed" | "failed" | "aborted";

interface Entry {
  id: string;
  index: number;
  agent: string;
  status: Status;
  detached: boolean;
  /** Its foreground `subagent` call ended: no later frame of that call can reach it. */
  callEnded?: true;
  description?: string;
  task?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  progress: Record<string, unknown>;
  lastUpdate: number;
}

const ASYNC_WIDGET = "subagent-async";
const ASYNC_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
/** tau addresses a subagent by an id it can put in a file name (SUBAGENT_ID_RE). */
const idPart = (value: unknown) => String(value).replace(/[^A-Za-z0-9_-]/g, "_");
/** The roster id of row `index` of the `subagent` call `toolCallId`; the session file's history uses it too. */
export const foregroundSubagentId = (toolCallId: string, index: number) => `${idPart(toolCallId)}.${index}`;
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const terminal = (status: Status) => status !== "started";

function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/** A foreground AgentProgress row as tau's SubagentProgress. */
function rowProgress(id: string, row: Record<string, unknown>, status: ProgressStatus): Record<string, unknown> {
  const started = number(row.startedAt), ended = number(row.endedAt) ?? number(row.lastActivityAt);
  return defined({
    id, index: number(row.index), agent: text(row.agent), status, task: text(row.task) ?? text(row.progressText),
    currentTool: text(row.currentTool), currentToolArgs: text(row.currentToolArgs), currentToolStartMs: number(row.currentToolStartedAt),
    recentTools: Array.isArray(row.recentTools) ? row.recentTools : undefined,
    recentOutput: Array.isArray(row.recentOutput) ? row.recentOutput : undefined,
    toolCount: number(row.toolCount), tokens: number(row.tokens), contextTokens: number(row.window), resolvedModel: text(row.model),
    durationMs: number(row.durationMs) ?? (started !== undefined && ended !== undefined ? ended - started : undefined),
  });
}

const ROW_STATUS: Record<string, [Status, ProgressStatus]> = {
  pending: ["started", "pending"], running: ["started", "running"], detached: ["started", "running"],
  completed: ["completed", "completed"], failed: ["failed", "failed"],
};
const NODE_STATUS: Record<string, [Status, ProgressStatus]> = {
  queued: ["started", "pending"], running: ["started", "running"], paused: ["started", "running"],
  complete: ["completed", "completed"], failed: ["failed", "failed"], partial: ["failed", "failed"], rejected: ["failed", "failed"],
  stopped: ["aborted", "aborted"],
};

export class SubagentBridge {
  private readonly entries = new Map<string, Entry>();

  /** The frames one pi frame stands for, or null when it reports no subagent. `consume`: the raw frame is only transport. */
  translate(frame: Frame): { frames: Frame[]; consume: boolean } | null {
    if ((frame.type === "tool_execution_update" || frame.type === "tool_execution_end") && frame.toolName === "subagent") {
      return { frames: this.foreground(frame), consume: false };
    }
    if (frame.type === "extension_ui_request" && frame.method === "setWidget" && frame.widgetKey === ASYNC_WIDGET) {
      const line = Array.isArray(frame.widgetLines) ? frame.widgetLines[0] : undefined;
      if (typeof line !== "string" || !line.startsWith(ASYNC_PREFIX)) return { frames: [], consume: true };
      try {
        return { frames: this.background(JSON.parse(line.slice(ASYNC_PREFIX.length))), consume: true };
      } catch {
        return { frames: [], consume: true };
      }
    }
    return null;
  }

  /** The children still running, as get_subagents answers them. A foreground child still detached when its call ended is
   *  left out: no later frame of that call can end it (a wait on it reports under another call), so a snapshot would keep
   *  it running for good. */
  running(): Array<Record<string, unknown>> {
    return [...this.entries.values()].filter((entry) => !terminal(entry.status) && !(entry.detached && entry.callEnded))
      .map((entry) => { const copy: Partial<Entry> = { ...entry }; delete copy.callEnded; return defined(copy); });
  }

  private foreground(frame: Frame): Frame[] {
    const toolCallId = text(frame.toolCallId);
    const result = frame.type === "tool_execution_end" ? frame.result : frame.partialResult;
    const rows = isRecord(result) && isRecord(result.details) && Array.isArray(result.details.progress) ? result.details.progress : [];
    if (!toolCallId) return [];
    const frames: Frame[] = [];
    rows.forEach((row: unknown, position: number) => {
      if (!isRecord(row)) return;
      const index = number(row.index) ?? position;
      const id = foregroundSubagentId(toolCallId, index);
      let [status, progressStatus] = ROW_STATUS[String(row.status)] ?? ["started", "running"];
      // The call ended: a child it still lists as running ended with it. A detached child is paused, not ended:
      // pi-subagents keeps it in its foreground runs until someone waits on it.
      if (frame.type === "tool_execution_end" && !terminal(status) && row.status !== "detached") [status, progressStatus] = frame.isError === true ? ["failed", "failed"] : ["completed", "completed"];
      frames.push(...this.update({
        id, index, agent: text(row.agent) ?? "subagent", status, detached: row.status === "detached",
        description: text(row.sessionName), task: text(row.task), sessionFile: text(row.sessionFile), parentToolCallId: toolCallId,
        ...(frame.type === "tool_execution_end" ? { callEnded: true as const } : {}),
        progress: rowProgress(id, row, progressStatus), lastUpdate: Date.now(),
      }));
    });
    return frames;
  }

  private background(snapshot: unknown): Frame[] {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.runs)) return [];
    const frames: Frame[] = [];
    const visit = (node: unknown, index: number) => {
      if (!isRecord(node) || typeof node.id !== "string" || node.kind === "host-step") return;
      const id = `async.${idPart(node.id)}`;
      const [status, progressStatus] = NODE_STATUS[String(node.state)] ?? ["started", "running"];
      const activity = isRecord(node.activity) ? node.activity : {};
      const started = number(node.startedAt), ended = number(node.endedAt) ?? number(node.updatedAt);
      const agent = text(node.agent) ?? text(node.label) ?? "subagent";
      frames.push(...this.update({
        id, index, agent, status, detached: true, description: text(node.label), task: text(node.progressText),
        progress: defined({
          id, index, agent, status: progressStatus, task: text(node.progressText), currentTool: text(activity.currentTool),
          currentToolStartMs: number(activity.currentToolStartedAt), toolCount: number(activity.toolCount), resolvedModel: text(node.model),
          durationMs: started !== undefined && ended !== undefined ? ended - started : undefined,
        }),
        lastUpdate: Date.now(),
      }));
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    snapshot.runs.forEach(visit);
    return frames;
  }

  /** Lifecycle before progress for a new child (the roster drops progress for one it lacks), progress before its end. */
  private update(next: Entry): Frame[] {
    const previous = this.entries.get(next.id);
    if (previous && terminal(previous.status)) return [];
    this.entries.set(next.id, next);
    const lifecycle: Frame = {
      type: "subagent_lifecycle",
      payload: defined({ id: next.id, agent: next.agent, status: next.status, index: next.index, description: next.description,
        sessionFile: next.sessionFile, parentToolCallId: next.parentToolCallId, detached: next.detached }),
    };
    const progress: Frame = {
      type: "subagent_progress",
      payload: defined({ index: next.index, agent: next.agent, task: next.task, sessionFile: next.sessionFile,
        parentToolCallId: next.parentToolCallId, detached: next.detached, progress: next.progress }),
    };
    const progressed = JSON.stringify(previous?.progress) !== JSON.stringify(next.progress);
    if (!previous) return [lifecycle, progress];
    if (previous.status !== next.status || previous.detached !== next.detached) return progressed ? [progress, lifecycle] : [lifecycle];
    return progressed ? [progress] : [];
  }
}
