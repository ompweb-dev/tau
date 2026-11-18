// What a main server that missed a child's output needs from it in the
// daemon's `hello`: the blocking requests still open on it, and the session it runs now.
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";

/** One line of `pi --mode rpc` stdout/stdin, keyed by `type`. */
export type WireFrame = { type: string; [key: string]: unknown };
/** An AgentSession event. */
export type WireEvent = { type: string; [key: string]: unknown };

export function parseWire(line: string): WireFrame | null {
  try {
    const frame: unknown = JSON.parse(line);
    return isRecord(frame) && typeof frame.type === "string" ? (frame as WireFrame) : null;
  } catch {
    return null;
  }
}

export function wireEvent(frame: WireFrame): WireEvent | null {
  if (frame.type === "response" || frame.type === "extension_ui_request" || frame.type === "extension_ui_response") {
    return null;
  }
  return frame;
}

/** Wire ids are strings in pi RPC; a link may still send numbers. */
export const idOf = (value: unknown): string | null =>
  typeof value === "string" || typeof value === "number" ? String(value) : null;

const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const OPENS = new Map([["ui_request", "ui"], ["host_tool_call", "tool"], ["host_uri_request", "uri"]]);
const CLOSES = new Map([["ui_end", "ui"], ["ui_response", "ui"], ["extension_ui_response", "ui"], ["host_tool_result", "tool"], ["host_uri_result", "uri"]]);
const CANCELS = new Map([["host_tool_cancel", "tool"], ["host_uri_cancel", "uri"]]);

/** The blocking request a frame opens or closes. */
export function requestKey(frame: WireFrame): { key: string; open: boolean } | null {
  if (frame.type === "extension_ui_request") {
    const id = idOf(frame.id);
    if (id !== null && typeof frame.method === "string" && DIALOG_UI_METHODS.has(frame.method)) {
      return { key: `ui:${id}`, open: true };
    }
    return null;
  }
  const open = OPENS.get(frame.type);
  const close = CLOSES.get(frame.type);
  const cancel = CANCELS.get(frame.type);
  const id = idOf(cancel ? frame.targetId : frame.id);
  const kind = open ?? close ?? cancel;
  return kind && id !== null ? { key: `${kind}:${id}`, open: open !== undefined } : null;
}

// A line without one of these cannot matter: skips JSON-parsing streamed output.
const STDOUT_LINES = /"type":"(?:extension_ui_request|session|ui_request|ui_end|host_tool_call|host_tool_cancel|host_uri_request|host_uri_cancel|agent_start|agent_end)"|"command":"get_state"/;
const STDIN_LINES = /"type":"(?:extension_ui_response|ui_response|host_tool_result|host_uri_result)"/;

export class PendingRequests {
  /** Raw line of each open request, or null once it no longer fits under the cap. */
  private readonly open = new Map<string, string | null>();
  private bytes = 0;
  private turning = false;

  /** Executing an agent turn, not merely holding an idle child process open. */
  get activeTurn(): boolean { return this.turning; }

  /** `sessionId`: the session the child runs, as `get_state` / `session` frames name it. */
  constructor(private readonly limitBytes: number, public sessionId: string | null = null) {}

  noteStdout(line: string): void {
    if (!STDOUT_LINES.test(line)) return;
    const frame = parseWire(line);
    if (!frame) return;
    const request = requestKey(frame);
    if (request) {
      this.close(request.key);
      if (request.open) this.keep(request.key, line);
      return;
    }
    const event = wireEvent(frame);
    if (event?.type === "agent_start") this.turning = true;
    else if (event?.type === "agent_end") this.turning = false;
    if (frame.type === "response" && frame.command === "get_state" && frame.success === true && isRecord(frame.data)) {
      const id = frame.data.sessionId;
      this.sessionId = typeof id === "string" && isValidSessionId(id) ? id : null;
    } else if (frame.type === "session") {
      this.sessionId = typeof frame.sessionId === "string" && isValidSessionId(frame.sessionId) ? frame.sessionId : null;
    }
  }

  noteStdin(line: string): void {
    if (!STDIN_LINES.test(line)) return;
    const frame = parseWire(line);
    const request = frame && requestKey(frame);
    if (request && !request.open) this.close(request.key);
  }

  /** Raw lines of the open requests in order; null when they exceed the cap. */
  lines(): string[] | null {
    const lines: string[] = [];
    for (const line of this.open.values()) {
      if (line === null) return null;
      lines.push(line);
    }
    return lines;
  }

  private close(key: string): void {
    const line = this.open.get(key);
    if (line) this.bytes -= Buffer.byteLength(line);
    this.open.delete(key);
  }

  private keep(key: string, line: string): void {
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.limitBytes) { this.open.set(key, null); return; }
    this.bytes += size;
    this.open.set(key, line);
  }
}
