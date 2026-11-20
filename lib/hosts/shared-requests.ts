import { isRecord } from "../type-guards";
import { HostOpError } from "./link-protocol";
import { requestKey, type WireFrame } from "./pending-requests";

/** `def`: the tool definition pi was advertised when it made the call. */
type Callback = { frame: WireFrame; lines: string[]; executor: string | null; def?: string };
type Registration = { tools: Record<string, unknown>[] };
type SharedRequestDeps = {
  members(): string[];
  isUp(id: string): boolean;
  deliver(id: string, lines: string[]): void;
  /** Sends a daemon-owned `cmd`. `onReply`: pi read it (its successful reply arrived); called before any later output is handled. */
  write(op: string, args: Record<string, unknown>, onReply?: () => void): void;
};

export function validateHostTools(tools: unknown[]): void {
  const valid = Array.isArray(tools) && tools.every(tool => isRecord(tool) && typeof tool.name === "string" && tool.name.length > 0
    && (tool.description === undefined || typeof tool.description === "string")
    && (tool.label === undefined || typeof tool.label === "string")
    && (tool.parameters === undefined || isRecord(tool.parameters)));
  if (!valid) throw new HostOpError(400, "invalid_request", "Invalid host tool registration");
}

export class SharedRequests {
  private readonly dialogs = new Map<string, string[]>();
  private readonly callbacks = new Map<string, Callback>();
  private readonly completed = new Set<string>();
  private readonly registrations = new Map<string, Registration>();
  private lastPrompt: string | null = null;
  /** Name -> the definition (JSON) last advertised to pi, kept after a removal: a call pi made just before it was
   * withdrawn still names that definition. A call goes only to a server registering exactly the one it pinned. */
  private toolDefs = new Map<string, string>();
  private toolUnion = "[]";

  constructor(private readonly deps: SharedRequestDeps) {}

  isCompleted(frame: WireFrame): boolean {
    const request = requestKey(frame);
    return request !== null && request.open && this.completed.has(request.key);
  }

  /** True: broadcast this frame; callbacks alone have one executor. */
  note(frame: WireFrame, line: string): boolean {
    const request = requestKey(frame);
    if (!request) return true;
    if (request.open && this.completed.has(request.key)) return false;
    if (frame.type === "ui_request" || frame.type === "extension_ui_request") this.dialogs.set(request.key, [line]);
    else if (frame.type === "ui_end") { this.dialogs.delete(request.key); this.completed.add(request.key); }
    else if (request.open) {
      if (!this.callbacks.has(request.key)) this.callbacks.set(request.key, { frame: { type: frame.type, toolName: frame.toolName }, lines: [line], executor: null,
        def: this.toolDefs.get(frame.toolName as string) });
      this.dispatch();
      return false;
    } else {
      const call = this.callbacks.get(request.key);
      if (call?.executor) this.deps.deliver(call.executor, [line]);
      this.callbacks.delete(request.key);
      this.completed.add(request.key);
      return false;
    }
    return true;
  }

  answer(id: string, frame: WireFrame): boolean {
    const request = requestKey(frame);
    if (!request || request.open) return false;
    if (frame.type === "ui_response" || frame.type === "extension_ui_response") {
      if (!this.dialogs.delete(request.key)) return false;
      this.completed.add(request.key);
      const end = JSON.stringify({ type: "ui_end", id: frame.id });
      for (const other of this.deps.members()) if (other !== id) this.deps.deliver(other, [end]);
      return true;
    }
    const call = this.callbacks.get(request.key);
    if (!call || call.executor !== id) return false;
    this.callbacks.delete(request.key);
    this.completed.add(request.key);
    return true;
  }

  prompt(id: string): void { this.lastPrompt = id; }

  setTools(id: string, tools: unknown[]): void {
    validateHostTools(tools);
    this.registrations.set(id, { tools: tools as Record<string, unknown>[] });
    this.updateUnion(); this.dispatch();
  }

  remove(id: string): void { this.registrations.delete(id); this.updateUnion(); this.dispatch(); }
  linkChanged(): void { this.dispatch(); }

  pending(id: string): string[] {
    return [...this.dialogs.values(), ...[...this.callbacks.values()].filter(call => call.executor === id).map(call => call.lines)].flat();
  }

  private updateUnion(): void {
    const tools = new Map<string, Record<string, unknown>>();
    for (const id of this.deps.members()) {
      const registration = this.registrations.get(id);
      for (const tool of registration?.tools ?? []) if (!tools.has(tool.name as string)) tools.set(tool.name as string, tool);
    }
    // pi's output is ordered: a call read before its reply to this union was made under the previous definitions.
    const advertised = [...tools].map(([name, tool]) => [name, JSON.stringify(tool)] as const);
    const confirm = () => { for (const [name, def] of advertised) this.toolDefs.set(name, def); };
    const mergedTools = [...tools.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const toolUnion = JSON.stringify(mergedTools);
    if (toolUnion !== this.toolUnion) { this.toolUnion = toolUnion; this.deps.write("set_host_tools", { tools: mergedTools }, confirm); }
  }

  private eligible(id: string, call: Callback): boolean {
    if (!this.deps.isUp(id) || !this.deps.members().includes(id)) return false;
    return this.registrations.get(id)?.tools.some(tool => tool.name === call.frame.toolName && JSON.stringify(tool) === call.def) ?? false;
  }

  private dispatch(): void {
    for (const call of this.callbacks.values()) {
      // A lost acknowledgement does not prove the action did not happen.
      if (call.executor !== null) continue;
      const executor = this.lastPrompt && this.eligible(this.lastPrompt, call) ? this.lastPrompt : this.deps.members().find(id => this.eligible(id, call));
      if (!executor) continue;
      call.executor = executor;
      this.deps.deliver(executor, call.lines);
    }
  }
}
