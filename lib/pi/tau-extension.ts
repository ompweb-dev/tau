/**
 * Companion pi extension for tau (loaded via `pi --mode rpc --extension ...`).
 *
 * Bridges tau-specific capabilities over pi's standard RPC + Extension UI protocol:
 *   1. Host tools the server registers (`/tau_host_tools`), called via `ctx.ui.input("__tau_host_tool__", ...)`
 *   2. Interactive `ask` tool via `ctx.ui.input("__tau_ask__", ...)`
 *   3. `clientMessageId` / `origin` tracking via `/tau_meta` + `input` / `message_start`
 *   4. `/btw` side-question bridge (`/btw`, `/tau_btw`)
 *   5. `pi-subagents` event bridge (`pi.events`)
 */

interface PiUI {
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

interface PiContext {
  ui: PiUI;
  cwd: string;
  sessionManager?: {
    getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
  };
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

interface MessageMeta {
  clientMessageId?: string;
  origin?: string;
}

interface BtwEntry {
  id: string;
  question: string;
  status: "running" | "done" | "error" | "cancelled";
  answer?: string;
  createdAt: number;
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

  // 3. clientMessageId / origin tracking
  const pendingMeta: MessageMeta[] = [];

  pi.registerCommand("tau_meta", {
    description: "Attach clientMessageId/origin metadata to the next user message",
    handler(args) {
      try {
        const parsed = JSON.parse(args) as MessageMeta;
        if (parsed && (parsed.clientMessageId || parsed.origin)) {
          pendingMeta.push({
            ...(parsed.clientMessageId ? { clientMessageId: String(parsed.clientMessageId) } : {}),
            ...(parsed.origin ? { origin: String(parsed.origin) } : {}),
          });
        }
      } catch {
        // Ignore malformed metadata payloads.
      }
    },
  });

  pi.on("message_start", (event, ctx) => {
    const msg = event.message as { role?: string } | undefined;
    if (msg?.role !== "user" || pendingMeta.length === 0) return;
    const meta = pendingMeta.shift()!;
    pi.appendEntry("tau_message_meta", meta);
    ctx.ui.setStatus("tau-meta", JSON.stringify(meta));
  });

  // 4. /btw side-question bridge
  const btwHistory: BtwEntry[] = [];

  pi.registerCommand("tau_btw", {
    description: "Handle tau /btw side-question commands",
    handler(args, ctx) {
      const trimmed = args.trim();
      if (!trimmed) return;
      try {
        const cmd = JSON.parse(trimmed) as { action?: string; id?: string; question?: string };
        if (cmd.action === "history") {
          ctx.ui.setWidget("tau-btw", [JSON.stringify({ type: "btw_history", entries: btwHistory })]);
          return;
        }
        if (cmd.action === "cancel" && cmd.id) {
          const entry = btwHistory.find((e) => e.id === cmd.id);
          if (entry && entry.status === "running") {
            entry.status = "cancelled";
            ctx.ui.setWidget("tau-btw", [JSON.stringify({ type: "btw_cancelled", id: entry.id })]);
          }
          return;
        }
        if (cmd.question) {
          const entry: BtwEntry = {
            id: cmd.id || `btw-${Date.now()}`,
            question: cmd.question,
            status: "done",
            answer: "",
            createdAt: Date.now(),
          };
          btwHistory.push(entry);
          pi.appendEntry("tau_btw", entry);
          ctx.ui.setWidget("tau-btw", [JSON.stringify({ type: "btw_entry", entry })]);
        }
      } catch {
        // Plain text fallback
      }
    },
  });

  pi.registerCommand("btw", {
    description: "Ask a side question without modifying the main conversation",
    handler(args, ctx) {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <question>", "warning");
        return;
      }
      const entry: BtwEntry = {
        id: `btw-${Date.now()}`,
        question,
        status: "done",
        createdAt: Date.now(),
      };
      btwHistory.push(entry);
      pi.appendEntry("tau_btw", entry);
      ctx.ui.setWidget("tau-btw", [JSON.stringify({ type: "btw_entry", entry })]);
    },
  });

  // 5. pi-subagents event bridge
  const subagentEvents = [
    "subagent:start",
    "subagent:update",
    "subagent:end",
    "subagent_start",
    "subagent_update",
    "subagent_end",
    "pi-subagents:event",
  ];
  let lastCtx: PiContext | null = null;
  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
  });
  for (const eventName of subagentEvents) {
    pi.events.on(eventName, (data) => {
      lastCtx?.ui.setStatus("tau-subagent", JSON.stringify({ event: eventName, data }));
    });
  }
}
