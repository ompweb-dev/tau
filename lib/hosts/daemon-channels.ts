import { randomUUID } from "node:crypto";
import type { SpawnRequest, SpawnResult } from "./host";
import type { RpcTransport } from "../pi/rpc-transport";
import { readSessionHeaderSync } from "../pi/session-files";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";
import type { DaemonLink } from "./daemon-link";
import { CONFIG_VERSION_RE, CREATION_ID_RE, HISTORY_MUTATING_COMMANDS, HostOpError, LINK_LIMITS, MESSAGE_COMMANDS, PEER_MESSAGE_FRAME, PEER_PROMPT_OUTCOME_FRAME, type HelloChannel, type HostUriScheme, type OpenChannelRequest, type OpenChannelResult, type Unsequenced, type UpMessage } from "./link-protocol";
import { idOf, parseWire, PendingRequests, wireEvent, type WireFrame } from "./pending-requests";
import { StreamSnapshot } from "./stream-snapshot";
import { ChannelLifecycle } from "./channel-lifecycle";
import { SharedRequests } from "./shared-requests";
import { RESUME_PROMPT, type HostResumeEntry } from "./host-resume";

type Output = Unsequenced<Extract<UpMessage, { type: "stdout" | "stderr" | "exit" }>>;
/** `reply`: a response to this member's own command, which a reopen's snapshot never supersedes. `gap`: output to it was
 * dropped (overflow) since its last snapshot, so its next open needs one. */
type Member = { link: DaemonLink; paused: boolean; opens: number; queued: { body: Output; reply: boolean }[]; bytes: number; resync: boolean; gap: boolean };
type Channel = {
  ch: string; transport: RpcTransport; launch: SpawnRequest; cwd: string; fellBack: boolean;
  pending: PendingRequests; snapshot: StreamSnapshot; lifecycle?: ChannelLifecycle; shared?: SharedRequests;
  members: Map<string, Member>; aliases: Set<string>; files: Set<string>;
  /** Daemon cmd id -> the link that sent it (null once it left) and that link's own id: links number their commands alike. */
  commands: Map<string, { link: DaemonLink | null; id: unknown; op: string }>;
  /** `onReply`: runs as pi's successful reply is read, before the next stdout line. */
  internal: Map<string, { resolve(frame: WireFrame): void; reject(error: Error): void; timer: NodeJS.Timeout; onReply?(): void }>;
  startup: Promise<void>; exited: boolean; opened: boolean; forceTimer?: NodeJS.Timeout;
  /** The id given to the assistant message pi is streaming (piStreamFrame). */
  messageId?: string;
  /** The link holding the history-edit lease: other links' history mutations are refused. */
  editor?: string;
  /** Why the daemon stopped it (lifecycle reason or "asked"); unset for a crash. */
  stopReason?: string;
  /** omp accepted the resume prompt but has not started (or ended) that run yet: still recorded as running. */
  resuming?: boolean;
};
type ChannelDeps = {
  spawn(launch: SpawnRequest): Promise<SpawnResult>;
  prepareLaunch(launch: SpawnRequest): SpawnRequest;
  sessionId?(file: string): string | null;
  log(message: string): void;
  runningChanged?(): void;
  sessionsChanged?(): void;
  channelsChanged?(ch: string): void;
};
/** pi's companion extension asks for a host tool as an `input` dialog titled `__tau_host_tool__` (lib/pi/tau-extension.ts):
 * the daemon routes it as the `host_tool_call` it stands for, so one member executes it. */
function bridgedToolCall(frame: WireFrame): WireFrame | null {
  if (frame.type !== "extension_ui_request" || frame.method !== "input" || frame.title !== "__tau_host_tool__" || typeof frame.id !== "string" || typeof frame.placeholder !== "string") return null;
  try {
    const payload: unknown = JSON.parse(frame.placeholder);
    return isRecord(payload) && typeof payload.toolName === "string" ? { type: "host_tool_call", id: frame.id, toolName: payload.toolName, arguments: payload.args ?? {} } : null;
  } catch {
    return null;
  }
}
/** pi's wire deltas carry neither the message nor an id (pi docs/json.md) and its block starts no block: give its
 * assistant messages an id and its updates the shape lib/message-delta.ts rebuilds. Null for every other frame. */
function piStreamFrame(channel: Channel, frame: WireFrame): WireFrame | null {
  if (frame.messageId !== undefined) return null;
  const role = isRecord(frame.message) ? frame.message.role : undefined;
  if (frame.type === "message_start" && role === "assistant") return { ...frame, messageId: (channel.messageId = randomUUID()) };
  if (frame.type === "message_end" && role === "assistant" && channel.messageId) {
    const messageId = channel.messageId;
    channel.messageId = undefined;
    return { ...frame, messageId };
  }
  const update = frame.assistantMessageEvent;
  if (frame.type !== "message_update" || "message" in frame || !channel.messageId || !isRecord(update)) return null;
  const block = update.type === "text_start" ? { type: "text", text: "" }
    : update.type === "thinking_start" ? { type: "thinking", thinking: "" }
    : update.type === "toolcall_start" ? { type: "toolCall", id: update.id, name: update.toolName, arguments: {} }
    : undefined;
  return { ...frame, messageId: channel.messageId, message: { role: "assistant" }, ...(block ? { assistantMessageEvent: { ...update, block } } : {}) };
}
/** A companion-extension command (`/tau_*`, sent as a prompt): pi runs no turn for it, so it is no user message. */
const isExtensionCommand = (frame: Record<string, unknown>) => frame.type === "prompt" && typeof frame.message === "string" && frame.message.startsWith("/tau_");
/** The extension's answer to a bridged call: the tool result as the dialog's value. */
function bridgedToolResult(frame: WireFrame): WireFrame {
  const result = isRecord(frame.result) ? frame.result : { content: [{ type: "text", text: String(frame.result ?? "") }] };
  return { type: "extension_ui_response", id: frame.id, value: JSON.stringify({ ...result, ...(frame.isError !== undefined ? { isError: Boolean(frame.isError) } : {}) }) };
}
const invalid = (message = "Invalid channel request") => new HostOpError(400, "invalid_request", message);
/** A process start's launch, from what its opener asked: the wire never names the configuration server (it is the opening
 * link's own), and a configuration version passes only in its one valid form. */
function forStart(launch: SpawnRequest, link: DaemonLink, opener: SpawnRequest): SpawnRequest {
  const result = { ...launch };
  delete result.configServer; delete result.configVersion;
  if (typeof opener.configVersion === "string" && CONFIG_VERSION_RE.test(opener.configVersion)) {
    result.configVersion = opener.configVersion;
    result.configServer = link.login.url;
  }
  return result;
}

export class ChannelTable {
  private readonly channels = new Map<string, Channel>();
  private readonly spawning = new Map<string, Promise<Channel>>();
  private readonly pendingSpawns = new Set<Promise<Channel>>();
  /** Kept after exit: a late retry must never create a replacement child. */
  private readonly creations = new Map<string, { fingerprint: string; spawn: Promise<Channel> }>();
  private readonly mutating = new Map<string, Promise<void>>();
  private readonly goneLinks = new Set<string>();
  /** Exited channels whose open result is still queued for a paused member. */
  private readonly exitedHandoffs = new Map<string, Channel>();
  private spawningCount = 0;
  private commandId = 0;
  private stopped = false;
  constructor(private readonly deps: ChannelDeps) {}
  get size(): number { return this.channels.size; }
  get spawnsInFlight(): number { return this.spawningCount; }
  get activeTurns(): number {
    let active = 0;
    for (const channel of this.channels.values()) if (channel.lifecycle?.activeTurn ?? channel.pending.activeTurn) active++;
    return active;
  }
  maintenanceSessions(): { id: string | null; cwd: string; active: boolean }[] {
    return [...this.channels.values()].map(channel => ({
      id: channel.pending.sessionId, cwd: channel.cwd,
      active: (channel.lifecycle?.isRunning ?? channel.pending.activeTurn) || channel.resuming === true,
    }));
  }
  cwdForSession(id: string): string | undefined {
    for (const channel of this.channels.values()) if (channel.pending.sessionId === id) return channel.cwd;
    return undefined;
  }

  private identity(launch: SpawnRequest): string | null {
    return launch.sessionFile ? (this.deps.sessionId?.(launch.sessionFile) ?? readSessionHeaderSync(launch.sessionFile)?.id ?? null) : null;
  }
  private find(id: string | null, file: string): Channel | undefined {
    return [...this.channels.values()].find(channel => (id !== null && channel.aliases.has(id)) || (file !== "" && channel.files.has(file)));
  }

  async open(link: DaemonLink, args: OpenChannelRequest): Promise<OpenChannelResult> {
    if (this.goneLinks.has(link.id)) throw new HostOpError(503, "host_link_closed", "The host link closed during open");
    if (!isRecord(args) || !(args.sessionId === null || typeof args.sessionId === "string" && isValidSessionId(args.sessionId)) || !isRecord(args.launch)
      || (args.preparing !== undefined && typeof args.preparing !== "boolean")
      || (args.expectedChannel !== undefined && (typeof args.expectedChannel !== "string" || !args.expectedChannel))) throw invalid();
    let channel: Channel;
    if (args.expectedChannel !== undefined) {
      const advertised = this.channels.get(args.expectedChannel);
      const ownsCreation = typeof args.launch.creationId === "string" && advertised?.launch.creationId === args.launch.creationId;
      if (!advertised || advertised.exited
        || (!ownsCreation && (args.sessionId === null || !advertised.aliases.has(args.sessionId)))) {
        throw new HostOpError(404, "session_not_running", "The advertised session channel is no longer running");
      }
      await advertised.startup;
      if (advertised.exited || this.channels.get(args.expectedChannel) !== advertised
        || (!ownsCreation && (args.sessionId === null || !advertised.aliases.has(args.sessionId)))) {
        throw new HostOpError(404, "session_not_running", "The advertised session channel is no longer running");
      }
      channel = advertised;
    } else {
      channel = await this.ensure(args.sessionId, forStart(args.launch, link, args.launch), args.preparing ? link.id : undefined);
    }
    if (this.goneLinks.has(link.id)) {
      channel.lifecycle?.linkGone(link.id);
      throw new HostOpError(503, "host_link_closed", "The host link closed during open");
    }
    if (channel.exited || (args.sessionId !== null && this.mutating.has(args.sessionId)) || this.mutating.has(args.launch.sessionFile)) {
      if (args.expectedChannel !== undefined) throw new HostOpError(404, "session_not_running", "The advertised session channel is stopping");
      return this.open(link, args);
    }
    if (this.goneLinks.has(link.id)) {
      channel.lifecycle?.linkGone(link.id);
      throw new HostOpError(503, "host_link_closed", "The host link closed during open");
    }
    const joined = channel.opened;
    channel.opened = true;
    const continuous = this.join(channel, link);
    if (args.preparing) channel.lifecycle?.setPreparing(link.id, true);
    return this.snapshot(channel, link, joined, continuous);
  }

  private pendingFor(channel: Channel, link: DaemonLink): string[] | null {
    const pending = channel.shared?.pending(link.id) ?? channel.pending.lines();
    return pending && pending.reduce((sum, line) => sum + Buffer.byteLength(line), 0) <= LINK_LIMITS.pendingBytes ? pending : null;
  }
  /** `continuous`: the link already holds every output line in order (a server restart on the same link). */
  private snapshot(channel: Channel, link: DaemonLink, joined: boolean, continuous: boolean): OpenChannelResult {
    return { ch: channel.ch, joined, pending: this.pendingFor(channel, link), streaming: channel.snapshot.whole(), cwd: channel.cwd,
      fellBack: channel.fellBack,
      ...(continuous ? { continuous: true } : {}) };
  }

  private async ensure(id: string | null, requested: SpawnRequest, preparingLinkId?: string): Promise<Channel> {
    const creationId = requested.creationId;
    if (creationId !== undefined && (typeof creationId !== "string" || !CREATION_ID_RE.test(creationId))) throw invalid("Invalid creation identity");
    const fingerprint = creationId === undefined ? "" : JSON.stringify([requested.cwd, requested.recordedCwd ?? null, requested.sessionFile, requested.toolNames ?? null, requested.spawnModel ?? null]);
    const creation = creationId === undefined ? undefined : this.creations.get(creationId);
    if (creation) {
      if (creation.fingerprint !== fingerprint) throw new HostOpError(409, "creation_conflict", "Creation identity belongs to another request");
      const channel = await creation.spawn;
      if (channel.exited) throw new HostOpError(409, "creation_conflict", "Creation identity belongs to a completed child");
      return channel;
    }
    const launch = this.deps.prepareLaunch(requested);
    const file = launch.sessionFile;
    const identity = id ?? this.identity(launch);
    const mutation = (identity === null ? undefined : this.mutating.get(identity)) ?? this.mutating.get(file);
    if (mutation) { await mutation; return this.ensure(id, requested, preparingLinkId); }
    const existing = this.find(identity, file);
    if (existing) {
      await existing.startup;
      if ((identity !== null && this.mutating.has(identity)) || this.mutating.has(file)) return this.ensure(id, requested, preparingLinkId);
      if (existing.exited) return this.ensure(id, requested, preparingLinkId);
      return existing;
    }
    const key = identity ?? (file || null);
    const pending = key === null ? undefined : this.spawning.get(key);
    if (pending) {
      const channel = await pending;
      if ((identity !== null && this.mutating.has(identity)) || this.mutating.has(file)) return this.ensure(id, requested, preparingLinkId);
      if (channel.exited) return this.ensure(id, requested, preparingLinkId);
      return channel;
    }
    if (id !== null && file === "") throw new HostOpError(404, "session_not_running", "The session listed by the host is no longer running");
    // The header and requested identity must agree; aliases are accepted only for a running channel.
    const headerId = this.identity(launch);
    if (id !== null && headerId === null) throw new HostOpError(404, "session_not_found", "The session launch file no longer exists");
    if (id !== null && headerId !== null && headerId !== id) throw invalid("Session identity does not match its launch file");
    const spawn = this.create(launch, identity, preparingLinkId);
    if (creationId !== undefined) this.creations.set(creationId, { fingerprint, spawn });
    this.pendingSpawns.add(spawn);
    if (key !== null) this.spawning.set(key, spawn);
    try {
      const channel = await spawn;
      if ((identity !== null && this.mutating.has(identity)) || this.mutating.has(file)) return this.ensure(id, requested, preparingLinkId);
      return channel;
    }
    finally {
      this.pendingSpawns.delete(spawn);
      if (key !== null && this.spawning.get(key) === spawn) this.spawning.delete(key);
    }
  }

  private async create(launch: SpawnRequest, identity: string | null, preparingLinkId?: string): Promise<Channel> {
    this.spawningCount++;
    try {
      if (this.stopped) throw new HostOpError(503, "host_stopping", "tau host is stopping");
      const spawned = await this.deps.spawn(launch);
      if (this.stopped) { spawned.transport.killTree(true); throw new HostOpError(503, "host_stopping", "tau host is stopping"); }
      const ch = randomUUID();
      const channel: Channel = { ...spawned, ch, launch, pending: new PendingRequests(LINK_LIMITS.pendingBytes, identity), snapshot: new StreamSnapshot(),
        members: new Map(), aliases: new Set(identity ? [identity] : []), files: new Set(launch.sessionFile ? [launch.sessionFile] : []),
        commands: new Map(), internal: new Map(),
        startup: Promise.resolve(), exited: false, opened: false };
      this.channels.set(ch, channel);
      channel.lifecycle = new ChannelLifecycle({ stop: reason => { this.deps.log(`channel ${ch}: stopping (${reason})`); this.stopChannel(channel, reason); }, onRunning: () => this.deps.runningChanged?.() });
      if (preparingLinkId) channel.lifecycle.setPreparing(preparingLinkId, true);
      channel.shared = new SharedRequests({ members: () => [...channel.members.keys()], isUp: id => channel.members.get(id)?.link.isUp() ?? false,
        deliver: (id, lines) => { const member = channel.members.get(id); if (member) for (const line of lines) this.deliver(channel, member, { type: "stdout", ch, line }); },
        write: (op, args, onReply) => {
          // pi has neither command: the companion extension registers the tools it is sent; host URI schemes have no pi counterpart.
          if (op === "set_host_uri_schemes") return;
          const [command, commandArgs] = op === "set_host_tools" ? ["prompt", { message: `/tau_host_tools ${JSON.stringify(args.tools)}` }] : [op, args];
          void this.command(channel, command, commandArgs, onReply).catch(error => this.deps.log(`channel ${ch}: ${String(error)}`));
        } });
      spawned.transport.onLine(line => this.stdout(channel, line));
      // The last 500 bytes omp writes before startup settles, for the daemon's own log if it exits meanwhile; never sent on.
      let startupStderr: Buffer | null = Buffer.alloc(0);
      spawned.transport.onStderr(chunk => {
        if (startupStderr) startupStderr = Buffer.concat([startupStderr, Buffer.from(chunk.slice(-500))]).subarray(-500);
        this.broadcast(channel, { type: "stderr", ch, chunk });
      });
      spawned.transport.onExit((code, signal) => {
        if (startupStderr) this.deps.log(`channel ${ch}: pi exited during startup (code ${code ?? "null"}, signal ${signal ?? "none"}): ${JSON.stringify(startupStderr.toString("utf8"))}`);
        channel.exited = true; clearTimeout(channel.forceTimer);
        channel.lifecycle?.dispose(); channel.snapshot.clear();
        for (const pending of channel.internal.values()) { clearTimeout(pending.timer); pending.reject(new Error("pi exited")); }
        channel.internal.clear(); channel.commands.clear(); this.channels.delete(ch);
        // An open result still on its way must carry this exit after it (see release).
        if ([...channel.members.values()].some(member => member.paused)) this.exitedHandoffs.set(ch, channel);
        // A planned stop names its reason, so web apps do not report it as a crash.
        this.broadcast(channel, { type: "exit", ch, code, signal, ...(channel.stopReason ? { reason: channel.stopReason } : {}) }); this.deps.runningChanged?.();
        this.deps.channelsChanged?.(ch);
      });
      channel.startup = this.configure(channel).finally(() => channel.lifecycle?.setStartup(false));
      await channel.startup;
      startupStderr = null;
      if (channel.exited) throw new HostOpError(502, "host_process_exited", "pi exited during startup");
      this.deps.sessionsChanged?.();
      return channel;
    } finally { this.spawningCount--; }
  }

  private async configure(channel: Channel): Promise<void> {
    if (channel.exited) return;
    try {
      // Readiness: pi answers once its extensions have loaded, which may take as long as the hub waits for an open.
      const res = await this.command(channel, "get_state", {}, undefined, LINK_LIMITS.channelReadyMs);
      if (isRecord(res.data)) {
        this.noteIdentity(channel, res.data as WireFrame);
      }
    } catch (error) {
      if (channel.exited) return;
      channel.transport.killTree(true);
      throw new HostOpError(502, "host_process_exited", error instanceof Error ? error.message : "pi did not answer get_state");
    }
  }

  private command(channel: Channel, op: string, args: Record<string, unknown>, onReply?: () => void, timeoutMs = 15000): Promise<WireFrame> {
    if (channel.exited) return Promise.reject(new Error("pi exited"));
    const id = String(++this.commandId);
    const command = { ...args, type: op, id };
    const { promise, resolve, reject } = Promise.withResolvers<WireFrame>();
    const timer = setTimeout(() => { channel.internal.delete(id); channel.lifecycle?.forgetCommand(id); reject(new Error(`pi ${op} timed out`)); }, timeoutMs); timer.unref?.();
    channel.internal.set(id, { resolve, reject, timer, onReply });
    // A companion-extension command starts no run (older pi's reply never says so).
    if (!isExtensionCommand(command)) channel.lifecycle?.noteStdin(command);
    channel.transport.write(JSON.stringify(command) + "\n", error => {
      if (error) { const pending = channel.internal.get(id); if (!pending) return; clearTimeout(pending.timer); channel.internal.delete(id); channel.lifecycle?.forgetCommand(id, true); reject(error); }
    });
    return promise;
  }

  /** `get_state` and `session` name the session pi runs now. */
  private noteIdentity(channel: Channel, frame: WireFrame): void {
    const id = frame.sessionId;
    if (typeof id === "string" && isValidSessionId(id) && id !== channel.pending.sessionId) {
      if (channel.pending.sessionId) { channel.aliases.clear(); channel.files.clear(); }
      channel.pending.sessionId = id; channel.aliases.add(id); if (channel.opened) this.deps.channelsChanged?.(channel.ch);
    }
    if (typeof frame.sessionFile === "string" && frame.sessionFile) {
      try { const launch = this.deps.prepareLaunch({ ...channel.launch, sessionFile: frame.sessionFile }); channel.launch = launch; channel.files.add(launch.sessionFile); } catch { /* Never trust an out-of-root native path. */ }
    }
    this.deps.runningChanged?.();
  }

  private stdout(channel: Channel, rawLine: string): void {
    const parsed = parseWire(rawLine);
    if (!parsed) {
      for (const member of channel.members.values()) member.link.queue({ type: "resync", ch: channel.ch }, channel.ch);
      return;
    }
    const changed = bridgedToolCall(parsed) ?? piStreamFrame(channel, parsed);
    const frame = changed ?? parsed, line = changed ? JSON.stringify(changed) : rawLine;
    if (frame.type === "session") this.noteIdentity(channel, frame);
    if (channel.shared?.isCompleted(frame)) return;
    channel.lifecycle?.noteStdout(frame);
    const agentEvent = wireEvent(frame);
    const event = agentEvent ?? frame;
    if (agentEvent) channel.snapshot.note(agentEvent);
    if (event?.type === "agent_start" || event?.type === "agent_end" || event?.type === "session_info_update") this.deps.sessionsChanged?.();
    if (channel.resuming && (event?.type === "agent_start" || event?.type === "agent_end")) { channel.resuming = false; this.deps.runningChanged?.(); }
    if (frame.type === "response" && (typeof frame.id === "string" || typeof frame.id === "number")) {
      const fid = String(frame.id);
      if (frame.command === "get_state" && frame.success === true && isRecord(frame.data)) {
        this.noteIdentity(channel, frame.data as WireFrame);
      }
      const pending = channel.internal.get(fid);
      if (pending) {
        clearTimeout(pending.timer); channel.internal.delete(fid);
        if (frame.success === false) pending.reject(new Error(String(frame.error ?? "pi command failed"))); else { pending.onReply?.(); pending.resolve(frame); }
        return;
      }
      const owner = channel.commands.get(fid);
      if (owner) {
        if (!MESSAGE_COMMANDS.has(owner.op)) channel.commands.delete(fid);
        const member = owner.link && channel.members.get(owner.link.id);
        if (member) this.deliver(channel, member, { type: "stdout", ch: channel.ch, line: JSON.stringify({ ...frame, id: owner.id }) }, true);
        return;
      }
      return;
    }
    if ((frame.type === "prompt_result" || frame.type === "prompt_error" || frame.type === "bash_output" || frame.type === "bash_execution_update") && (typeof frame.id === "string" || typeof frame.id === "number")) {
      const fid = String(frame.id);
      const owner = channel.commands.get(fid);
      if (owner) {
        if (frame.type === "prompt_result" || frame.type === "prompt_error") channel.commands.delete(fid);
        const member = owner.link && channel.members.get(owner.link.id);
        if (member) this.deliver(channel, member, { type: "stdout", ch: channel.ch, line: JSON.stringify({ ...frame, id: owner.id }) });
        if (frame.type === "prompt_result" || frame.type === "prompt_error") {
          const outcome: WireFrame = { ...frame }; delete outcome.id;
          const peer = JSON.stringify({ type: PEER_PROMPT_OUTCOME_FRAME, outcome });
          for (const other of channel.members.values()) if (other !== member) this.deliver(channel, other, { type: "stdout", ch: channel.ch, line: peer });
        }
        return;
      }
    }
    if (channel.shared?.note(frame, line) === false) return;
    this.broadcast(channel, { type: "stdout", ch: channel.ch, line });
  }

  /** True when `link` was a member with no output dropped since its last snapshot (a server restart on the same link). */
  private join(channel: Channel, link: DaemonLink): boolean {
    const member = channel.members.get(link.id);
    if (member) {
      // The snapshot supersedes queued output, never this link's command replies (FIFO before the result in the sender).
      const continuous = !member.gap && !member.resync && member.queued.every(item => item.reply);
      member.paused = true; member.opens++; member.resync = false; member.gap = false;
      member.queued = member.queued.filter(item => item.reply);
      member.bytes = member.queued.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.body)), 0);
      return continuous;
    }
    link.discard(channel.ch);
    channel.members.set(link.id, { link, paused: true, opens: 1, queued: [], bytes: 0, resync: false, gap: false });
    channel.lifecycle?.setInterest(link.id, false);
    return false;
  }

  /** Called only after the open result has been queued under this channel's key. */
  release(link: DaemonLink, ch: string): void {
    const channel = this.channels.get(ch) ?? this.exitedHandoffs.get(ch), member = channel?.members.get(link.id);
    if (!channel || !member) return;
    member.opens = Math.max(0, member.opens - 1);
    if (member.opens > 0) return;
    member.paused = false;
    if (member.resync) link.queue({ type: "resync", ch }, ch);
    else for (const item of member.queued) this.deliver(channel, member, item.body);
    member.queued = []; member.bytes = 0; member.resync = false;
    if (channel.exited && ![...channel.members.values()].some(other => other.paused)) this.exitedHandoffs.delete(ch);
  }

  private deliver(channel: Channel, member: Member, body: Output, reply = false): void {
    if (member.paused) {
      member.bytes += Buffer.byteLength(JSON.stringify(body));
      if (member.bytes > LINK_LIMITS.channelBufferBytes) { member.queued = []; member.resync = true; member.gap = true; }
      else if (!member.resync) member.queued.push({ body, reply });
    } else if (body.type === "exit") member.link.queue(body, channel.ch);
    else member.link.output(body, channel.pending.sessionId);
  }
  private broadcast(channel: Channel, body: Output): void { for (const member of channel.members.values()) this.deliver(channel, member, body); }
  private member(link: DaemonLink, ch: string): Channel {
    const channel = this.channels.get(ch);
    if (!channel || !channel.members.has(link.id)) throw new HostOpError(403, "channel_not_joined", "This link has not joined the channel");
    return channel;
  }

  stdin(link: DaemonLink, ch: string, line: string): void {
    const channel = this.member(link, ch);
    const frame = parseWire(line);
    if (!frame) throw invalid("Invalid channel frame");
    const member = channel.members.get(link.id)!;
    const isReply = ["extension_ui_response", "ui_response", "host_tool_result", "host_uri_result"].includes(frame.type);
    const op = isReply ? null : frame.type;
    const extension = isExtensionCommand(frame);
    const refuse = (code: string, error: string) => {
      if (op !== null) this.deliver(channel, member, { type: "stdout", ch, line: JSON.stringify({ type: "response", id: frame.id, command: op, success: false, code, error }) }, true);
    };
    if (op !== null && !extension && channel.editor !== undefined && channel.editor !== link.id && HISTORY_MUTATING_COMMANDS.has(op)) {
      return refuse("session_busy", "Another web app is editing this session's history; retry once it finishes");
    }
    if (op !== null && ["set_host_tools", "set_host_uri_schemes"].includes(op)) throw invalid("This command is owned by the host daemon");
    if (extension && /^\/tau_host_tools\b/.test(frame.message as string)) throw invalid("This command is owned by the host daemon");
    let out = frame, id: string | null = null;
    if (isReply) {
      if (!channel.shared?.answer(link.id, frame)) return;
      if (frame.type === "host_tool_result") out = bridgedToolResult(frame);
    } else if (op !== null) {
      if (idOf(frame.id) === null) throw invalid("Invalid channel command id");
      id = String(++this.commandId);
      // An extension command's reply ends it: never kept for a prompt_result like a message command.
      channel.commands.set(id, { link, id: frame.id, op: extension ? "extension_command" : op });
      out = { ...frame, id };
    }
    if (op !== null && !extension && MESSAGE_COMMANDS.has(op)) {
      channel.shared?.prompt(link.id);
      const marker = JSON.stringify({ type: PEER_MESSAGE_FRAME });
      for (const [other, peer] of channel.members) if (other !== link.id) this.deliver(channel, peer, { type: "stdout", ch, line: marker });
    }
    channel.lifecycle?.noteStdin(out);
    channel.transport.write(JSON.stringify(out) + "\n", error => {
      if (!error || id === null) return;
      channel.commands.delete(id); channel.lifecycle?.forgetCommand(id, true);
      if (channel.members.has(link.id)) refuse("write_failed", error.message);
    });
  }
  setInterest(link: DaemonLink, ch: string, on: boolean, preparing: boolean): void {
    const channel = this.member(link, ch); channel.lifecycle?.setInterest(link.id, on); channel.lifecycle?.setPreparing(link.id, preparing);
  }
  /** The history-edit lease, acknowledged so a competing editor fails before its preflight. */
  editLease(link: DaemonLink, ch: string, on: boolean): void {
    const channel = this.member(link, ch);
    if (!on) { if (channel.editor === link.id) channel.editor = undefined; return; }
    if (channel.editor !== undefined && channel.editor !== link.id) throw new HostOpError(409, "session_busy", "Another web app is editing this session's history; retry once it finishes");
    channel.editor = link.id;
  }
  setTools(link: DaemonLink, ch: string, tools: unknown[], schemes: HostUriScheme[]): void { this.member(link, ch).shared?.setTools(link.id, tools, schemes); }
  kill(link: DaemonLink, ch: string, force: boolean): void { const channel = this.member(link, ch); if (force) { channel.stopReason ??= "asked"; channel.transport.killTree(true); } else this.stopChannel(channel); }
  close(link: DaemonLink, ch: string): void {
    const channel = this.member(link, ch); channel.members.delete(link.id); channel.lifecycle?.setPreparing(link.id, false); channel.lifecycle?.linkGone(link.id); channel.shared?.remove(link.id);
    if (channel.editor === link.id) channel.editor = undefined;
    link.discard(ch);
    for (const owner of channel.commands.values()) if (owner.link?.id === link.id) owner.link = null;
  }
  linkDown(link: DaemonLink): void {
    for (const channel of this.channels.values()) {
      channel.lifecycle?.linkDown(link.id); channel.shared?.linkChanged();
      // A restarted server forgets its edit; a dropped holder's edit fails as host_offline anyway.
      if (channel.editor === link.id) channel.editor = undefined;
    }
  }
  linkUp(link: DaemonLink): void { for (const channel of this.channels.values()) { channel.lifecycle?.linkUp(link.id); channel.shared?.linkChanged(); } }
  linkGone(link: DaemonLink): void {
    this.goneLinks.add(link.id);
    for (const [ch, channel] of this.exitedHandoffs) {
      channel.members.delete(link.id);
      if (![...channel.members.values()].some(member => member.paused)) this.exitedHandoffs.delete(ch);
    }
    for (const channel of this.channels.values()) if (channel.members.has(link.id)) this.close(link, channel.ch);
  }
  members(ch: string): DaemonLink[] { return [...(this.channels.get(ch)?.members.values() ?? [])].map(member => member.link); }
  listing(link: DaemonLink, replay = true): HelloChannel[] {
    return [...this.channels.values()]
      .map(channel => ({ ch: channel.ch, sessionId: channel.pending.sessionId, cwd: channel.cwd, pending: replay ? this.pendingFor(channel, link) : null,
        ...(channel.launch.creationId === undefined ? {} : { creationId: channel.launch.creationId }) }));
  }
  running(): HostResumeEntry[] {
    // A recovered session starts on the version already applied: the resume manifest never names one.
    return [...this.channels.values()].filter(channel => (channel.lifecycle?.isRunning || channel.resuming) && channel.pending.sessionId && channel.launch.sessionFile)
      .map(channel => { const launch = { ...channel.launch }; delete launch.configVersion; delete launch.configServer; return { sessionId: channel.pending.sessionId!, launch }; });
  }
  /** Resumes each entry once; returns the entries whose resume failed. */
  async recover(entries: HostResumeEntry[]): Promise<HostResumeEntry[]> {
    const results = await Promise.allSettled(entries.map(async entry => {
      const lease = "d:resume";
      const channel = await this.ensure(entry.sessionId, entry.launch, lease);
      channel.lifecycle?.setPreparing(lease, true);
      try {
        channel.opened = true;
        this.deps.channelsChanged?.(channel.ch);
        // Recorded until the run starts or ends; omp's reply can come before agent_start.
        channel.resuming = true;
        try { await this.command(channel, "prompt", { message: RESUME_PROMPT }); }
        catch (error) { channel.resuming = false; throw error; }
      } finally {
        channel.lifecycle?.setPreparing(lease, false);
      }
    }));
    return results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      this.deps.log(`could not resume session ${entries[index].sessionId}: ${String(result.reason)}`);
      return [entries[index]];
    });
  }
  async mutateSession<T>(id: string, action: (canonicalId: string, liveIds: string[]) => Promise<T>): Promise<T> {
    if (!isValidSessionId(id)) throw invalid("Invalid session id");
    while (this.mutating.has(id)) await this.mutating.get(id);
    const { promise, resolve } = Promise.withResolvers<void>();
    const keys = new Set([id]);
    const protect = (channel?: Channel) => {
      for (const key of [...(channel?.aliases ?? []), ...(channel?.files ?? [])]) keys.add(key);
      for (const key of keys) this.mutating.set(key, promise);
    };
    // Continuation aliases never retarget a destructive action to a different stored session.
    const findTarget = () => {
      for (const live of this.channels.values()) if (live.pending.sessionId === id) return live;
      return undefined;
    };
    let channel = findTarget();
    protect();
    try {
      if (!channel) await this.spawning.get(id)?.catch(() => undefined);
      channel = findTarget();
      protect(channel);
      if (channel && !channel.exited) {
        const exit = Promise.withResolvers<void>();
        channel.transport.onExit(() => exit.resolve()); this.stopChannel(channel); await exit.promise;
      }
      const liveIds = [...this.channels.values()].flatMap(live => live.pending.sessionId ? [live.pending.sessionId] : []);
      return await action(id, liveIds);
    } finally {
      for (const key of keys) if (this.mutating.get(key) === promise) this.mutating.delete(key);
      resolve();
    }
  }

  private stopChannel(channel: Channel, reason = "asked"): void {
    channel.stopReason ??= reason;
    channel.transport.killTree(false); clearTimeout(channel.forceTimer);
    if (!channel.exited) { channel.forceTimer = setTimeout(() => channel.transport.killTree(true), 5000); channel.forceTimer.unref?.(); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const exits = [...this.channels.values()].map(channel => {
      if (channel.exited) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      channel.transport.onExit(() => resolve()); this.stopChannel(channel);
      return promise;
    });
    await Promise.all([...exits, ...[...this.pendingSpawns].map(spawn => spawn.catch(() => {}))]);
  }
}
