import type { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";
import { isRecord } from "../type-guards";
import { OMP_NOT_FOUND, resolveOmpBin } from "./omp-cli";
import { type RpcTransport, spawnLocalRpcTransport } from "./rpc-transport";
import { LINK_LIMITS } from "../hosts/link-protocol";

/**
 * Process + protocol layer for `pi --mode rpc` (NDJSON over stdio).
 *
 *   Commands (tau -> pi):     { id: string, type: string, ...args }
 *   Responses (pi -> tau):    { id?: string, type: "response", command: string, success: boolean, data?, error? }
 *   Events (pi -> tau):       { type: "agent_start" | "message_update" | ..., ... }
 *   Extension UI (pi -> tau): { type: "extension_ui_request", id: string, method: ..., ... }
 *   Extension UI (tau -> pi): { type: "extension_ui_response", id: string, value?, confirmed?, cancelled? }
 */

export type RpcFrame = { type: string; [key: string]: unknown };

export class RpcCommandError extends Error {
  readonly command: string;
  readonly code?: string;

  constructor(command: string, message: string, code?: string) {
    super(message);
    this.name = "RpcCommandError";
    this.command = command;
    this.code = code;
  }
}

export class RpcCommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;
  /** When the command went to the transport (or its wait started); a timer fires timeoutMs later. */
  readonly dispatchedAt: number;

  constructor(command: string, timeoutMs: number, message?: string, dispatchedAt = Date.now() - timeoutMs) {
    super(message ?? `RPC command ${command} timed out after ${timeoutMs}ms`);
    this.name = "RpcCommandTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.dispatchedAt = dispatchedAt;
  }
}

interface PendingCommand {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  onReply?: (success: boolean, id: string) => void;
}

export interface RpcProcessOptions {
  /** Working directory for the agent. */
  cwd: string;
  /** Extra CLI args appended after `--mode rpc [--extension ...]`. */
  extraArgs?: string[];
  /** Environment overrides merged over process.env. */
  env?: Record<string, string>;
  /** Called for every non-response frame (events, extension UI, subagent frames). */
  onFrame?: (frame: RpcFrame) => void;
  /** Called once when the child exits, after pending commands are rejected. */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
  /** Byte transport to run over. Omitted -> spawn `pi --mode rpc` (see spawnLocalRpcTransport). */
  transport?: RpcTransport;
  /** The daemon already saw this child's startup, or it outlived its server: ready at once,
   * and frames are held until `release` (after `replay`). */
  adopted?: true;
  /** Injectable process boundary for deterministic transport tests. */
  dependencies?: {
    resolveOmpBin?: typeof resolveOmpBin;
    spawn?: typeof spawn;
  };
}

const STDERR_TAIL_LIMIT = 8 * 1024;
/**
 * Largest line tau writes to pi's stdin. Command bodies are already capped at 8 MiB by the
 * agent routes (`MAX_AGENT_COMMAND_REQUEST_BYTES`); this bound only turns a pathological command
 * into a clear error instead of an unbounded pipe write.
 */
const MAX_INBOUND_LINE_BYTES = 32 * 1024 * 1024;
const READY_PROBE_ID = "__tau_ready__";
const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const COMMAND_MAP: Record<string, string> = {
  get_available_commands: "get_commands",
};

/** A stdout line as JSON; undefined when blank or not JSON (never let a stray line kill the reader). */
function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

const REQUEST_TYPES = new Set(["host_tool_call", "host_uri_request", "ui_request"]);
const requestId = (frame: RpcFrame) => {
  if (frame.type === "extension_ui_request" && typeof frame.method === "string" && DIALOG_UI_METHODS.has(frame.method) && typeof frame.id === "string") {
    return frame.id;
  }
  return REQUEST_TYPES.has(frame.type) && (typeof frame.id === "string" || typeof frame.id === "number") ? String(frame.id) : null;
};

/** Locate the companion pi extension bundled with tau, if present on disk. */
export function resolveTauExtensionPath(): string | null {
  if (process.env.TAU_NO_EXTENSION === "1") return null;
  const packageRoot = process.env.OMP_WEB_PACKAGE_DIR;
  if (packageRoot) {
    const candidate = join(packageRoot, "lib", "pi", "tau-extension.ts");
    if (existsSync(candidate)) return candidate;
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, "..", "pi", "tau-extension.ts");
    if (existsSync(candidate)) return candidate;
  } catch {
    // Compiled binary or virtual URL: fall back to cwd.
  }
  const cwdCandidate = join(process.cwd(), "lib", "pi", "tau-extension.ts");
  return existsSync(cwdCandidate) ? cwdCandidate : null;
}

/** Spawns `pi --mode rpc` with the sanitized child environment. */
export function spawnOmpTransport(options: RpcProcessOptions): RpcTransport {
  const resolveBin = options.dependencies?.resolveOmpBin ?? resolveOmpBin;
  const bin = resolveBin();
  if (!bin) {
    throw new Error(OMP_NOT_FOUND);
  }
  const extPath = resolveTauExtensionPath();
  const args = ["--mode", "rpc", ...(extPath ? ["--extension", extPath] : []), ...(options.extraArgs ?? [])];
  const env = sanitizeProjectCommandEnvironment({ ...process.env, ...options.env });
  if (options.env?.OMP_PROFILE === undefined) delete env.OMP_PROFILE;
  if (options.env?.PI_PROFILE === undefined) delete env.PI_PROFILE;
  return spawnLocalRpcTransport({ bin, args, cwd: options.cwd, env, spawn: options.dependencies?.spawn });
}

export class RpcProcess {
  readonly cwd: string;
  /** Read by the session wrapper for host-specific signals (a remote link's resync and lost child). */
  readonly transport: RpcTransport;
  private readonly exitedPromise: Promise<void>;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly frameListeners = new Set<(frame: RpcFrame) => void>();
  private readyPromise: Promise<RpcFrame>;
  private readonly resolveReady: (frame: RpcFrame) => void;
  /** An adopted child's frames, held until `release` (see RpcProcessOptions.adopted), and the bytes of its lines since. */
  private heldFrames: RpcFrame[] | null = null;
  private heldBytes = 0;
  /** Set once an adopted child's output outgrew the cap before `release`: the adoption fails. */
  private heldOverflow: Error | null = null;
  /** Ids of the requests `replay` delivered (see `release`). */
  private readonly replayedRequests = new Set<string>();
  /** Extension UI request ids bridged from `tau-extension.ts` (`__tau_host_tool__` / `__tau_ask__`). */
  private readonly extensionBridgeIds = new Set<string>();
  /** Standard pi extension dialog methods awaiting `ui_response` -> `extension_ui_response`. */
  private readonly extensionDialogMethods = new Map<string, string>();
  private nextId = 1;
  /** Companion-extension calls awaiting their `tau_reply` frame (see `callExtension`). */
  private readonly extensionReplies = new Map<string, { command: string; resolve(data: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  /** Whether pi has settled since its last `agent_start` (`agent_settled`); null for an adopted child whose history is unknown. */
  private settled: boolean | null;
  /** The last `queue_update`: pi's `get_state` reports only `pendingMessageCount`. */
  private lastQueue: { steering: unknown[]; followUp: unknown[] } | null = null;
  private stderrTail = "";
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  // Lines are written one at a time so two of them cannot interleave on the pipe.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RpcProcessOptions) {
    this.transport = options.transport ?? spawnOmpTransport(options);
    this.cwd = options.cwd;
    if (options.onFrame) this.frameListeners.add(options.onFrame);

    const ready = Promise.withResolvers<RpcFrame>();
    this.readyPromise = ready.promise;
    this.resolveReady = ready.resolve;
    // waitReady() is optional for callers; avoid unhandled-rejection noise when
    // the process dies before anyone awaited readiness.
    this.readyPromise.catch(() => {});
    const exitDeferred = Promise.withResolvers<void>();
    this.exitedPromise = exitDeferred.promise;
    this.settled = options.adopted ? null : true;
    if (options.adopted) {
      this.heldFrames = [];
      ready.resolve({ type: "ready" });
    }

    this.transport.onLine((line) => {
      if (this.heldFrames && !this.holdable(line)) return;
      const parsed = parseLine(line);
      if (parsed !== undefined) this.receive(parsed);
    });

    this.transport.onStderr((chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    this.transport.onExit((code, signal) => {
      if (this.exited) return;
      this.exited = true;
      this.exitInfo = { code, signal };
      const exitError = new Error(
        `pi exited (code ${code ?? "null"}, signal ${signal ?? "none"})${this.stderrTail ? `: ${this.stderrTail.slice(-500)}` : ""}`,
      );
      ready.reject(exitError);
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(exitError);
      }
      this.pending.clear();
      for (const [, entry] of this.extensionReplies) {
        clearTimeout(entry.timer);
        entry.reject(exitError);
      }
      this.extensionReplies.clear();
      exitDeferred.resolve();
      options.onExit?.({ code, signal, stderrTail: this.stderrTail });
    });

    if (!options.adopted) {
      // Probe readiness via get_state so waitReady() confirms pi is booted and reading stdin.
      this.writeFrame({ id: READY_PROBE_ID, type: "get_state" }, () => {});
    }
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  get exitDetails(): { code: number | null; signal: NodeJS.Signals | null; stderrTail: string } | null {
    return this.exitInfo ? { ...this.exitInfo, stderrTail: this.stderrTail } : null;
  }

  /** Resolves with `{type:"ready", ...state}`; rejects if the process dies first or the
   * timeout elapses. pi startup can take a few seconds (extensions, discovery). */
  waitReady(timeoutMs = 60_000): Promise<RpcFrame> {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`pi ready timeout after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
      this.readyPromise.finally(() => clearTimeout(timer)).catch(() => {});
    });
    return Promise.race([this.readyPromise, timeout]);
  }

  onFrame(listener: (frame: RpcFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Adopted child: feeds the daemon's raw lines of its still-open requests as
   * if just read. They are older than anything held, which `release` delivers next. */
  replay(lines: string[]): void {
    if (this.heldOverflow) throw this.heldOverflow;
    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed !== undefined) this.receive(parsed, true);
    }
  }

  /** Adopted child, after `replay`: delivers the frames held since and stops holding. */
  release(): void {
    if (this.heldOverflow) throw this.heldOverflow;
    const held = this.heldFrames ?? [];
    this.heldFrames = null;
    for (const frame of held) {
      const id = requestId(frame);
      if (id === null || !this.replayedRequests.has(id)) this.dispatch(frame);
    }
    this.replayedRequests.clear();
  }

  private holdable(line: string): boolean {
    if (this.heldOverflow) return false;
    this.heldBytes += Buffer.byteLength(line);
    if (this.heldBytes <= LINK_LIMITS.channelBufferBytes) return true;
    const overflow = new Error(`pi's output during adoption exceeded ${LINK_LIMITS.channelBufferBytes} bytes`);
    this.heldOverflow = overflow;
    this.heldFrames = [];
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(overflow);
    }
    this.pending.clear();
    return false;
  }

  /** One JSONL frame from `pi --mode rpc`. `replayed`: a daemon line (see `replay`). */
  private receive(parsed: unknown, replayed = false): void {
    if (!isRecord(parsed) || typeof parsed.type !== "string") return;
    if (parsed.type === "response") {
      if (parsed.id === READY_PROBE_ID) {
        const state = parsed.success === true && isRecord(parsed.data) ? parsed.data : {};
        this.resolveReady({ type: "ready", ...state });
        return;
      }
      this.handleResponse(parsed);
      return;
    }
    if (parsed.type === "ready" || parsed.type === "hello") {
      this.resolveReady({ ...parsed, type: "ready" });
      return;
    }
    if (parsed.type === "extension_ui_request" && typeof parsed.method === "string") {
      const translated = this.translateExtensionUiRequest(parsed);
      if (translated) this.dispatch(translated, replayed);
      return;
    }
    if (parsed.type === "agent_start") this.settled = false;
    if (parsed.type === "queue_update") {
      this.lastQueue = { steering: Array.isArray(parsed.steering) ? parsed.steering : [], followUp: Array.isArray(parsed.followUp) ? parsed.followUp : [] };
    }
    if (parsed.type === "agent_settled") {
      this.settled = true;
      // tau names the end of a run and everything it continues into `session_settled`.
      this.dispatch({ ...parsed, type: "session_settled" }, replayed);
      return;
    }
    this.dispatch(parsed as RpcFrame, replayed);
  }

  private translateExtensionUiRequest(req: Record<string, unknown>): RpcFrame | null {
    const id = typeof req.id === "string" ? req.id : String(req.id ?? "");
    const method = String(req.method);
    if (method === "input" && req.title === "__tau_host_tool__" && typeof req.placeholder === "string") {
      try {
        const payload = JSON.parse(req.placeholder) as { toolName?: string; args?: unknown };
        if (id && typeof payload.toolName === "string") {
          this.extensionBridgeIds.add(id);
          return { type: "host_tool_call", id, toolName: payload.toolName, arguments: payload.args ?? {} };
        }
      } catch {
        // Fall through to standard input dialog if malformed.
      }
    }
    if (method === "input" && req.title === "__tau_ask__" && typeof req.placeholder === "string") {
      try {
        const payload = JSON.parse(req.placeholder) as Record<string, unknown>;
        if (id) {
          this.extensionBridgeIds.add(id);
          return { type: "ui_request", id, method: "askDialog", args: [payload] };
        }
      } catch {
        // Fall through.
      }
    }
    if (DIALOG_UI_METHODS.has(method) && id) {
      this.extensionDialogMethods.set(id, method);
      const args = method === "select"
        ? [req.title, req.options]
        : method === "confirm"
          ? [req.title, req.message]
          : method === "input"
            ? [req.title, req.placeholder]
            : [req.title, req.prefill];
      return { type: "ui_request", id, method, args };
    }
    if (method === "notify") {
      return { type: "notice", level: typeof req.notifyType === "string" ? req.notifyType : "info", message: String(req.message ?? "") };
    }
    if (method === "setWidget" && req.widgetKey === "tau" && Array.isArray(req.widgetLines) && typeof req.widgetLines[0] === "string") {
      try {
        const btw = JSON.parse(req.widgetLines[0]) as RpcFrame;
        if (btw && btw.type === "tau_reply") {
          // Answers one of this process's extension calls; another server's calls name ids it never made.
          const entry = typeof btw.replyId === "string" ? this.extensionReplies.get(btw.replyId) : undefined;
          if (entry) {
            this.extensionReplies.delete(btw.replyId as string);
            clearTimeout(entry.timer);
            if (typeof btw.error === "string") entry.reject(new RpcCommandError(entry.command, btw.error));
            else entry.resolve(btw.data);
          }
          return null;
        }
        if (btw && typeof btw.type === "string") return btw;
      } catch {
        // Ignore malformed widget payload.
      }
    }
    return req as RpcFrame;
  }

  private dispatch(frame: RpcFrame, replayed = false): void {
    if (this.heldFrames && !replayed) {
      this.heldFrames.push(frame);
      return;
    }
    const id = replayed ? requestId(frame) : null;
    if (id !== null) this.replayedRequests.add(id);
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // Listener bugs must not break the protocol reader.
      }
    }
  }

  /** Send an RPC command and await its response `data`. A failed response rejects
   * with RpcCommandError. */
  sendCommand<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs?: number, onReply?: (success: boolean, id: string) => void): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error("pi process has exited"));
    }
    if (this.heldOverflow) return Promise.reject(this.heldOverflow);
    const dispatchedAt = Date.now();
    const id = String(this.nextId++);
    const mappedType = COMMAND_MAP[command.type] ?? command.type;
    const wireCommand = { ...command, type: mappedType, id };
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCommand = {
        command: mappedType,
        resolve: resolve as (data: unknown) => void,
        reject,
        onReply,
      };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.get(id) === entry) {
            this.pending.delete(id);
            reject(new RpcCommandTimeoutError(mappedType, timeoutMs, undefined, dispatchedAt));
          }
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.writeFrame(wireCommand, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            reject(error);
          }
        }
      });
    });
  }

  /**
   * Calls a companion-extension command (`/<command> <json>`, lib/pi/tau-extension.ts). pi starts no run for it and its
   * prompt reply carries no data, so the extension answers with a `tau_reply` frame naming `replyId`.
   */
  callExtension<T = unknown>(command: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const replyId = randomUUID();
    const reply = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.extensionReplies.delete(replyId);
        reject(new RpcCommandTimeoutError(command, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.extensionReplies.set(replyId, { command, resolve: resolve as (data: unknown) => void, reject, timer });
    });
    // The reply may come before or after pi's own prompt reply; only a refused prompt settles the call by itself.
    this.sendCommand({ type: "prompt", message: `/${command} ${JSON.stringify({ ...args, replyId })}` }, timeoutMs).catch((error: Error) => {
      const entry = this.extensionReplies.get(replyId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.extensionReplies.delete(replyId);
      entry.reject(error);
    });
    return reply;
  }

  /** Fire-and-forget frame (`extension_ui_response`, etc.). */
  sendFrame(frame: { type: string; [key: string]: unknown }): void {
    if (this.exited) return;
    const id = frame.id !== undefined && frame.id !== null ? String(frame.id) : "";
    if (frame.type === "host_tool_result" && id && this.extensionBridgeIds.delete(id)) {
      const value = JSON.stringify({
        ...(isRecord(frame.result) ? frame.result : { content: [{ type: "text", text: String(frame.result ?? "") }] }),
        ...(frame.isError !== undefined ? { isError: Boolean(frame.isError) } : {}),
      });
      this.writeFrame({ type: "extension_ui_response", id, value }, () => {});
      return;
    }
    if (frame.type === "ui_response" && id) {
      if (this.extensionBridgeIds.delete(id)) {
        if (frame.value === undefined) {
          this.writeFrame({ type: "extension_ui_response", id, cancelled: true }, () => {});
        } else {
          const value = typeof frame.value === "string" ? frame.value : JSON.stringify(frame.value);
          this.writeFrame({ type: "extension_ui_response", id, value }, () => {});
        }
        return;
      }
      const method = this.extensionDialogMethods.get(id);
      if (method) {
        this.extensionDialogMethods.delete(id);
        if (frame.value === undefined) {
          this.writeFrame({ type: "extension_ui_response", id, cancelled: true }, () => {});
        } else if (method === "confirm") {
          this.writeFrame({ type: "extension_ui_response", id, confirmed: Boolean(frame.value) }, () => {});
        } else {
          this.writeFrame({ type: "extension_ui_response", id, value: String(frame.value) }, () => {});
        }
        return;
      }
    }
    this.writeFrame(frame, () => {});
  }

  private writeFrame(frame: Record<string, unknown>, callback: (error?: Error | null) => void): void {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_INBOUND_LINE_BYTES) {
      callback(new Error(`pi command exceeds the ${MAX_INBOUND_LINE_BYTES}-byte inbound transport limit`));
      return;
    }
    this.writeQueue = this.writeQueue.then(
      () => new Promise<void>((resolve) => {
        if (this.exited) {
          callback(new Error("pi process is not running"));
          resolve();
          return;
        }
        this.transport.write(line, (error) => {
          callback(error ?? null);
          resolve();
        });
      }),
    );
  }

  /** A `response`; one for no pending command (timed out, or another server's) is dropped. */
  /** Fills the `get_state` fields tau reads that pi does not report: the queue, its size and settlement. */
  private withQueueAndSettlement(state: Record<string, unknown>): Record<string, unknown> {
    const pending = typeof state.pendingMessageCount === "number" ? state.pendingMessageCount : undefined;
    const out = { ...state };
    if (out.queuedMessageCount === undefined && pending !== undefined) out.queuedMessageCount = pending;
    if (out.queuedMessages === undefined && (this.lastQueue || pending === 0)) out.queuedMessages = this.lastQueue ?? { steering: [], followUp: [] };
    if (out.isSettled === undefined && this.settled !== null && pending !== undefined) {
      out.isSettled = this.settled && state.isStreaming !== true && state.isCompacting !== true && pending === 0;
    }
    return out;
  }

  private handleResponse(response: Record<string, unknown>): void {
    const id = response.id !== undefined && response.id !== null ? String(response.id) : null;
    const entry = id !== null ? this.pending.get(id) : undefined;
    if (!entry || id === null) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const ok = response.success === true;
    entry.onReply?.(ok, id);
    if (ok) {
      entry.resolve(entry.command === "get_state" && isRecord(response.data) ? this.withQueueAndSettlement(response.data) : response.data);
    } else {
      entry.reject(new RpcCommandError(entry.command, typeof response.error === "string" ? response.error : "pi command failed", typeof response.code === "string" ? response.code : undefined));
    }
  }

  /** Close shared membership unless explicitly stopping the child. Local shutdown
   * closes stdin, escalates to SIGTERM/SIGKILL and waits for actual exit. */
  async dispose(gracePeriodMs = 5_000, stopShared = false): Promise<void> {
    if (this.exited) return;
    if (this.transport.hostOwnedLifecycle) {
      if (!stopShared) {
        this.transport.close!();
        return;
      }
      this.transport.killTree(false);
    } else {
      this.transport.endInput();
    }
    const timer = setTimeout(() => {
      if (!this.exited) this.transport.killTree(false);
    }, gracePeriodMs);
    const killTimer = setTimeout(() => {
      if (!this.exited) this.transport.killTree(true);
    }, gracePeriodMs * 2);
    timer.unref?.();
    killTimer.unref?.();
    await this.exitedPromise;
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}
