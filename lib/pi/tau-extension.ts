/**
 * Companion pi extension for tau (loaded via `pi --mode rpc --extension ...`).
 *
 * Bridges tau-specific capabilities over pi's standard RPC + Extension UI protocol:
 *   1. Host tools the server registers (`/tau_host_tools`), called via `ctx.ui.input("__tau_host_tool__", ...)`
 *   2. Interactive `ask` tool via `ctx.ui.input("__tau_ask__", ...)`
 *   3. Message identity and origin (`/tau_meta`, `input`, `message_start`/`message_end`)
 *   4. `/btw` side questions (`/tau_btw`)
 *   5. History Edit (`/tau_edit`)
 *   6. Provider logins (`/tau_auth`), read and written through pi's own model runtime
 * pi-subagents needs no bridge here: tau reads its tool progress and `subagent-async` widget (lib/pi/subagent-bridge.ts).
 */

interface PiUI {
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

interface SessionEntry { id?: string; type?: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown } }

/** The subset of pi's AssistantMessageEventStream the side questions read. */
interface ModelStream extends AsyncIterable<{ type: string; delta?: string }> {
  result(): Promise<{ stopReason?: string; errorMessage?: string }>;
}

interface PiContext {
  ui: PiUI;
  cwd: string;
  isIdle?: () => boolean;
  model?: unknown;
  modelRegistry?: {
    streamSimple(model: unknown, context: { systemPrompt?: string; messages: unknown[] }, options?: { signal?: AbortSignal }): ModelStream;
    /** pi's ModelRuntime (TypeScript-private, public at runtime): the one owner of auth.json. */
    runtime?: ModelRuntime;
  };
  sessionManager?: {
    getEntries?: () => SessionEntry[];
    getBranch?: () => SessionEntry[];
    getLeafId?: () => string | null;
    getSessionId?: () => string;
    getEntry?: (id: string) => SessionEntry | undefined;
  };
  /** Command handlers only (ExtensionCommandContext). */
  navigateTree?: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
}

interface PiExtensionAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: PiContext,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }>;
  }): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: PiContext) => Promise<void> | void;
    },
  ): void;
  on(event: string, handler: (event: Record<string, unknown>, ctx: PiContext) => unknown): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data?: unknown): void;
  events: {
    on(event: string, handler: (data: unknown) => void): () => void;
    emit(event: string, data: unknown): void;
  };
}

/** The subset of pi's ModelRuntime (core/model-runtime.ts) and pi-ai's auth types that `/tau_auth` uses. */
type AuthPrompt = { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }
  | { type: "select"; message: string; options: readonly { id: string; label: string }[]; signal?: AbortSignal };
interface AuthInteraction { signal?: AbortSignal; prompt(prompt: AuthPrompt): Promise<string>; notify(event: Record<string, unknown> & { type: string }): void }
interface ModelRuntime {
  getProviders(): readonly { id: string; name: string; auth: { oauth?: unknown; apiKey?: { login?: unknown } } }[];
  getModels(providerId?: string): readonly unknown[];
  hasConfiguredAuth(providerId: string): boolean;
  listCredentials(): Promise<readonly { providerId: string; type: "api_key" | "oauth" }[]>;
  login(providerId: string, type: "api_key" | "oauth", interaction: AuthInteraction): Promise<unknown>;
  logout(providerId: string): Promise<void>;
  /** Private: models.json, whose providers tau edits in its own panel. */
  config?: { getProvider?(providerId: string): unknown };
}

/** tau's side-question record (lib/btw.ts): the first turn, then any follow-ups. */
type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";
interface BtwTurn { question: string; answer: string; status: BtwStatus; createdAt: number; updatedAt: number; error?: string }
interface BtwRecord extends BtwTurn { id: string; leafId: string | null; followUps?: BtwTurn[] }

/** Conversation text a side question is asked about: user and assistant text of the active branch, newest kept. */
const BTW_CONTEXT_CHARS = 200_000;
function conversationText(entries: SessionEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    const role = entry.type === "message" ? entry.message?.role : undefined;
    if (role !== "user" && role !== "assistant") continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : "";
    if (text.trim()) parts.push(`${role === "user" ? "User" : "Assistant"}: ${text.trim()}`);
  }
  // shortcut: a fixed character budget, not the model's context window; size it from ctx.model when that matters.
  return parts.join("\n\n").slice(-BTW_CONTEXT_CHARS);
}

function parseHostToolResponse(raw: string | undefined): {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
} {
  if (raw === undefined) {
    return { content: [{ type: "text", text: "Host tool call cancelled or timed out." }], isError: true };
  }
  try {
    const parsed = JSON.parse(raw) as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
      isError?: boolean;
      error?: string;
    };
    if (Array.isArray(parsed.content)) {
      return { content: parsed.content, details: parsed.details, isError: parsed.isError };
    }
    if (typeof parsed.error === "string") {
      return { content: [{ type: "text", text: parsed.error }], isError: true };
    }
    return { content: [{ type: "text", text: raw }], details: parsed };
  } catch {
    return { content: [{ type: "text", text: raw }] };
  }
}

function registerHostTool(
  pi: PiExtensionAPI,
  name: string,
  label: string,
  description: string,
  parameters: Record<string, unknown>,
): void {
  pi.registerTool({
    name,
    label,
    description,
    parameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const payload = JSON.stringify({ toolCallId, toolName: name, args: params });
      const raw = await ctx.ui.input("__tau_host_tool__", payload, { signal });
      return parseHostToolResponse(raw);
    },
  });
}

export default function tauExtension(pi: PiExtensionAPI): void {
  // 1. Host tools: the ones tau's server registers for this session (browser tools such as open_file, and the
  //    agent and GitHub tools while Settings allows them). The host daemon turns its `set_host_tools` union into
  //    `/tau_host_tools <json array>`; tools it no longer lists are deactivated, as pi cannot unregister one.
  const hostTools = new Set<string>();
  pi.registerCommand("tau_host_tools", {
    description: "Register the host tools tau's server names for this session",
    handler(args) {
      let tools: unknown;
      try {
        tools = JSON.parse(args);
      } catch {
        return;
      }
      if (!Array.isArray(tools)) return;
      const listed = new Set<string>();
      for (const tool of tools) {
        if (typeof tool !== "object" || tool === null || typeof (tool as { name?: unknown }).name !== "string") continue;
        const { name, description, parameters } = tool as { name: string; description?: unknown; parameters?: unknown };
        listed.add(name);
        registerHostTool(pi, name, name, typeof description === "string" ? description : "",
          typeof parameters === "object" && parameters !== null ? parameters as Record<string, unknown> : { type: "object", properties: {} });
        hostTools.add(name);
      }
      const active = pi.getActiveTools().filter((name) => !hostTools.has(name) || listed.has(name));
      pi.setActiveTools([...new Set([...active, ...listed])]);
    },
  });

  // 2. Interactive `ask` tool
  pi.registerTool({
    name: "ask",
    label: "Ask User",
    description: "Ask the user one or more structured questions in the tau UI and wait for their answers.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to present to the user.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              multiSelect: { type: "boolean" },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const payload = JSON.stringify({ toolCallId, ...params });
      const raw = await ctx.ui.input("__tau_ask__", payload, { signal });
      return parseHostToolResponse(raw);
    },
  });

  // 3. Message identity. pi keeps no client ids, so tau names each message just before sending it
  //    (`/tau_meta {action: "name", clientMessageId, origin, text}`). The input handler binds the name to the message
  //    pi admits with that text, tracking pi's steering and follow-up queues in their delivery order; message_start
  //    announces it (`tau_message_identity`, ahead of pi's own event) and message_end journals it as tau's
  //    `client-message-entry`, which the session reader joins to show origin cards.
  interface Named { clientMessageId: string; text: string; origin?: unknown }
  const MAX_PENDING_NAMES = 32;
  const named: Named[] = [];
  let starting: Named | null = null;
  let current: Named | null = null;
  const queued: Record<"steering" | "followUp", Named[]> = { steering: [], followUp: [] };
  const emitTau = (ctx: PiContext, frame: Record<string, unknown>) => ctx.ui.setWidget("tau", [JSON.stringify(frame)]);
  const emitQueue = (ctx: PiContext) => emitTau(ctx, {
    type: "tau_queue",
    steering: queued.steering.map(({ clientMessageId, origin }) => ({ clientMessageId, origin })),
    followUp: queued.followUp.map(({ clientMessageId, origin }) => ({ clientMessageId, origin })),
  });
  const textOf = (content: unknown) => typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("") : "";
  /** The queued message pi starts: steering goes first; text tells the queues apart unless a skill or template expanded it. */
  const takeQueued = (text: string): Named | null => {
    for (const queue of [queued.steering, queued.followUp]) if (queue[0]?.text === text) return queue.shift()!;
    for (const queue of [queued.steering, queued.followUp]) if (queue[0]?.text.startsWith("/")) return queue.shift()!;
    return queued.steering.shift() ?? queued.followUp.shift() ?? null;
  };
  const journaled = (ctx: PiContext) => {
    const ids = new Map<string, string>(), resolved = new Set<string>();
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      const data = entry.data as { clientMessageId?: unknown; entryId?: unknown; clientMessageIds?: unknown } | undefined;
      if (entry.type === "custom" && entry.customType === "client-message-entry" && typeof data?.clientMessageId === "string" && typeof data.entryId === "string") ids.set(data.clientMessageId, data.entryId);
      if (entry.type === "custom" && entry.customType === "client-message-resolution" && Array.isArray(data?.clientMessageIds)) for (const id of data.clientMessageIds) resolved.add(String(id));
    }
    return { ids, resolved };
  };

  // Announced at start, so tau names the very first message (an adopted process proves itself by any reply).
  pi.on("session_start", (_event, ctx) => emitTau(ctx, { type: "tau_hello" }));

  pi.registerCommand("tau_meta", {
    description: "tau's message identity (name, status, clear)",
    handler(args, ctx) {
      let cmd: { action?: unknown; replyId?: unknown; clientMessageId?: unknown; text?: unknown; origin?: unknown; clientMessageIds?: unknown };
      try {
        cmd = JSON.parse(args);
      } catch {
        return;
      }
      const reply = (data: unknown) => emitTau(ctx, { type: "tau_reply", replyId: cmd.replyId, data });
      if (cmd.action === "name" && typeof cmd.clientMessageId === "string" && typeof cmd.text === "string") {
        named.push({ clientMessageId: cmd.clientMessageId, text: cmd.text, ...(cmd.origin !== undefined ? { origin: cmd.origin } : {}) });
        // A name pi never admitted (its prompt refused, its text rewritten by a hook) must not wait for a twin forever.
        if (named.length > MAX_PENDING_NAMES) named.shift();
        return reply({ named: true });
      }
      if (cmd.action === "clear") {
        // tau took pi's queue back (clear_queue): those messages will never start.
        const withdrawn = [...queued.steering, ...queued.followUp].map((item) => item.clientMessageId);
        queued.steering = []; queued.followUp = [];
        if (withdrawn.length) pi.appendEntry("client-message-resolution", { clientMessageIds: withdrawn });
        emitQueue(ctx);
        return reply({ withdrawn });
      }
      if (cmd.action === "status" && Array.isArray(cmd.clientMessageIds)) {
        const asked = cmd.clientMessageIds.filter((id): id is string => typeof id === "string");
        const { ids, resolved } = journaled(ctx);
        const pending = new Set([...named, ...queued.steering, ...queued.followUp, ...(starting ? [starting] : []), ...(current ? [current] : [])].map((item) => item.clientMessageId));
        const messages = asked.flatMap((clientMessageId) => {
          const entry = ids.has(clientMessageId) ? ctx.sessionManager?.getEntry?.(ids.get(clientMessageId)!) : undefined;
          return entry?.message ? [{ clientMessageId, message: entry.message }] : [];
        });
        return reply({
          messages,
          queuedMessages: {
            steering: queued.steering.map((item) => item.text), followUp: queued.followUp.map((item) => item.text),
            clientMessageIds: { steering: queued.steering.map((item) => item.clientMessageId), followUp: queued.followUp.map((item) => item.clientMessageId) },
          },
          persistedClientMessageIds: asked.filter((id) => ids.has(id)),
          resolvedClientMessageIds: asked.filter((id) => resolved.has(id)),
          unresolvedClientMessageIds: asked.filter((id) => pending.has(id) && !ids.has(id) && !resolved.has(id)),
        });
      }
      reply(null);
    },
  });

  pi.on("input", (event, ctx) => {
    // A new prompt replaces one pi refused after its input handlers ran (no model or key), so that name never sticks.
    if (!event.streamingBehavior) starting = null;
    // Names go out in their prompts' order, so the oldest of equal texts is this one.
    const index = named.findIndex((item) => item.text === event.text);
    if (index === -1) return;
    const item = named.splice(index, 1)[0];
    if (event.streamingBehavior === "steer") queued.steering.push(item);
    else if (event.streamingBehavior === "followUp") queued.followUp.push(item);
    // A bare prompt during a run is refused right after its input handlers ("already processing"): it never starts.
    else if (ctx.isIdle?.() !== false) starting = item;
    if (event.streamingBehavior) emitQueue(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "user") return;
    // A prompt pi refused left no `starting`: the next prompt's input cleared it. Its text may differ from the name's
    // (a skill, a template, another extension's input transform), so it is not compared.
    const wasQueued = !starting;
    current = starting ?? takeQueued(textOf(message.content));
    starting = null;
    if (!current) return;
    emitTau(ctx, { type: "tau_message_identity", clientMessageId: current.clientMessageId, ...(current.origin !== undefined ? { origin: current.origin } : {}) });
    if (wasQueued) emitQueue(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; timestamp?: unknown } | undefined;
    if (message?.role !== "user" || !current) return;
    const named = current;
    current = null;
    // pi stores the message after its message_end handlers: journal it once its entry exists (found by timestamp).
    const journal = (attempt: number) => {
      const entry = (ctx.sessionManager?.getBranch?.() ?? []).findLast((item) => item.type === "message" && item.message?.role === "user"
        && (item.message as { timestamp?: unknown }).timestamp === message.timestamp) as (SessionEntry & { id?: string }) | undefined;
      if (entry?.id) pi.appendEntry("client-message-entry", { clientMessageId: named.clientMessageId, entryId: entry.id, ...(named.origin !== undefined ? { origin: named.origin } : {}) });
      else if (attempt < 50) setTimeout(() => journal(attempt + 1), 20);
    };
    setTimeout(() => journal(0), 0);
  });

  // 4. /btw side questions: answered from the conversation so far with the session's model, never added to it.
  //    tau calls `/tau_btw {action, replyId, ...}` and gets a `tau_reply` frame back; answers stream as `btw_delta`
  //    and `btw_record` frames (all through the `tau` widget, which tau's RpcProcess decodes).
  const btwRecords = new Map<string, BtwRecord>();
  const btwRunning = new Map<string, AbortController>();
  const latestTurn = (record: BtwRecord): BtwTurn => record.followUps?.at(-1) ?? record;
  const withLatest = (record: BtwRecord, patch: Partial<BtwTurn>): BtwRecord => {
    const followUps = record.followUps;
    if (!followUps?.length) return { ...record, ...patch };
    return { ...record, followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1], ...patch }] };
  };
  const emitBtw = (ctx: PiContext, frame: Record<string, unknown>) => ctx.ui.setWidget("tau", [JSON.stringify(frame)]);

  pi.on("session_start", (_event, ctx) => {
    btwRecords.clear();
    for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
      const record = entry.type === "custom" && entry.customType === "tau_btw" ? entry.data as BtwRecord : null;
      if (record && typeof record.id === "string") btwRecords.set(record.id, record);
    }
    // A record saved while running belonged to a process that is gone.
    for (const [id, record] of btwRecords) if (latestTurn(record).status === "running") btwRecords.set(id, withLatest(record, { status: "interrupted" }));
  });

  const finishBtw = (ctx: PiContext, id: string, patch: Partial<BtwTurn>) => {
    btwRunning.delete(id);
    const record = btwRecords.get(id);
    if (!record) return;
    const done = withLatest(record, { ...patch, updatedAt: Date.now() });
    btwRecords.set(id, done);
    pi.appendEntry("tau_btw", done);
    emitBtw(ctx, { type: "btw_record", record: done });
  };

  async function answerBtw(ctx: PiContext, id: string, signal: AbortSignal): Promise<void> {
    const record = btwRecords.get(id)!;
    const earlier = (record.followUps?.length ? [record, ...record.followUps.slice(0, -1)] : [])
      .map((turn) => `Side question: ${turn.question}\nYour answer: ${turn.answer}`).join("\n\n");
    const prompt = [
      "<conversation>", conversationText(ctx.sessionManager?.getBranch?.() ?? []), "</conversation>",
      ...(earlier ? ["", earlier] : []),
      "", `Side question: ${latestTurn(record).question}`,
    ].join("\n");
    let answer = "";
    try {
      const stream = ctx.modelRegistry!.streamSimple(ctx.model, {
        systemPrompt: "You answer a side question about the conversation shown. The conversation goes on without your answer: do not act or call tools, just answer briefly.",
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      }, { signal });
      for await (const event of stream) {
        if (event.type !== "text_delta" || !event.delta) continue;
        answer += event.delta;
        const current = btwRecords.get(id);
        if (current) btwRecords.set(id, withLatest(current, { answer }));
        emitBtw(ctx, { type: "btw_delta", recordId: id, delta: event.delta });
      }
      const result = await stream.result();
      if (signal.aborted || result.stopReason === "aborted") finishBtw(ctx, id, { answer, status: "cancelled" });
      else if (result.stopReason === "error") finishBtw(ctx, id, { answer, status: "error", error: result.errorMessage ?? "The model failed" });
      else finishBtw(ctx, id, { answer, status: "complete" });
    } catch (error) {
      finishBtw(ctx, id, signal.aborted ? { answer, status: "cancelled" } : { answer, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  pi.registerCommand("tau_btw", {
    description: "tau's side questions (ask, cancel, history)",
    handler(args, ctx) {
      let cmd: { action?: unknown; replyId?: unknown; question?: unknown; recordId?: unknown };
      try {
        cmd = JSON.parse(args);
      } catch {
        return;
      }
      const reply = (data: unknown) => emitBtw(ctx, { type: "tau_reply", replyId: cmd.replyId, data });
      const fail = (error: string) => emitBtw(ctx, { type: "tau_reply", replyId: cmd.replyId, error });
      if (cmd.action === "history") return reply({ records: [...btwRecords.values()] });
      if (cmd.action === "cancel") {
        const running = typeof cmd.recordId === "string" ? btwRunning.get(cmd.recordId) : undefined;
        running?.abort();
        return reply({ cancelled: running !== undefined });
      }
      if (cmd.action !== "ask") return fail("Unknown side-question action");
      const question = typeof cmd.question === "string" ? cmd.question.trim() : "";
      if (!question) return fail("A side question needs text");
      if (!ctx.model || !ctx.modelRegistry) return fail("No model is selected for this session");
      const now = Date.now();
      const turn: BtwTurn = { question, answer: "", status: "running", createdAt: now, updatedAt: now };
      let record: BtwRecord;
      if (typeof cmd.recordId === "string") {
        const existing = btwRecords.get(cmd.recordId);
        if (!existing) return fail("That side question is gone");
        if (btwRunning.has(existing.id)) return fail("That side question is still being answered");
        record = { ...existing, followUps: [...(existing.followUps ?? []), turn] };
      } else {
        record = { id: `btw-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, leafId: ctx.sessionManager?.getLeafId?.() ?? null, ...turn };
      }
      btwRecords.set(record.id, record);
      const controller = new AbortController();
      btwRunning.set(record.id, controller);
      reply({ record });
      emitBtw(ctx, { type: "btw_record", record });
      void answerBtw(ctx, record.id, controller.signal);
    },
  });

  // 5. History Edit: move the leaf to just before a user message, keeping the old branch (tau's edit_message).
  pi.registerCommand("tau_edit", {
    description: "tau's history Edit",
    async handler(args, ctx) {
      let cmd: { replyId?: unknown; entryId?: unknown };
      try {
        cmd = JSON.parse(args);
      } catch {
        return;
      }
      const reply = (frame: Record<string, unknown>) => ctx.ui.setWidget("tau", [JSON.stringify({ type: "tau_reply", replyId: cmd.replyId, ...frame })]);
      const entry = typeof cmd.entryId === "string" ? ctx.sessionManager?.getEntry?.(cmd.entryId) : undefined;
      if (entry?.type !== "message" || entry.message?.role !== "user") return reply({ error: "The edit target must be a user message" });
      try {
        const { cancelled } = await ctx.navigateTree!(cmd.entryId as string, { summarize: false });
        reply({ data: { sessionId: ctx.sessionManager?.getSessionId?.(), cancelled, leafId: ctx.sessionManager?.getLeafId?.() ?? null } });
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  // 6. Provider logins. tau calls `/tau_auth {action, replyId, ...}` and gets a `tau_reply`; a login streams its steps as
  //    `tau_auth_event` frames and asks for pasted codes and choices through `ctx.ui.input("__tau_auth_prompt__", <json>)`.
  //    Raw keys and tokens never leave pi: the providers list carries only the stored credential's type.
  pi.registerCommand("tau_auth", {
    description: "tau's provider logins",
    async handler(args, ctx) {
      let cmd: { replyId?: unknown; action?: unknown; provider?: unknown; key?: unknown };
      try {
        cmd = JSON.parse(args);
      } catch {
        return;
      }
      const send = (frame: Record<string, unknown>) => ctx.ui.setWidget("tau", [JSON.stringify({ replyId: cmd.replyId, ...frame })]);
      const runtime = ctx.modelRegistry?.runtime;
      const provider = typeof cmd.provider === "string" ? cmd.provider : "";
      try {
        if (!runtime) throw new Error("This pi version exposes no model runtime to extensions");
        if (cmd.action === "providers") {
          const stored = new Map((await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]));
          send({ type: "tau_reply", data: { providers: runtime.getProviders().map((entry) => ({
            id: entry.id,
            name: entry.name,
            oauth: Boolean(entry.auth.oauth),
            apiKeyLogin: Boolean(entry.auth.apiKey?.login),
            stored: stored.get(entry.id) ?? null,
            configured: runtime.hasConfiguredAuth(entry.id),
            custom: Boolean(runtime.config?.getProvider?.(entry.id)),
            models: runtime.getModels(entry.id).length,
          })) } });
        } else if (cmd.action === "logout") {
          await runtime.logout(provider);
          send({ type: "tau_reply", data: {} });
        } else if (cmd.action === "api_key") {
          const key = typeof cmd.key === "string" ? cmd.key : "";
          await runtime.login(provider, "api_key", {
            async prompt(prompt) {
              if (prompt.type === "secret" && key) return key;
              throw new Error(`${provider} asks for more than an API key ("${prompt.message}"); run \`pi auth login ${provider} --api-key\` on that host`);
            },
            notify() {},
          });
          send({ type: "tau_reply", data: {} });
        } else if (cmd.action === "login") {
          await runtime.login(provider, "oauth", {
            async prompt(prompt) {
              const { signal, ...shown } = prompt;
              const answer = await ctx.ui.input("__tau_auth_prompt__", JSON.stringify(shown), { signal });
              if (answer === undefined) throw new Error("Login cancelled");
              return answer;
            },
            notify(event) {
              send({ type: "tau_auth_event", event });
            },
          });
          send({ type: "tau_reply", data: {} });
        } else {
          throw new Error("Unknown auth action");
        }
      } catch (error) {
        send({ type: "tau_reply", error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}
