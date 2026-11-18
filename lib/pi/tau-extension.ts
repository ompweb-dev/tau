/**
 * Companion pi extension for tau (loaded via `pi --mode rpc --extension ...`).
 *
 * Bridges tau-specific capabilities over pi's standard RPC + Extension UI protocol:
 *   1. Host tools (`open_file`, `github_*`) via `ctx.ui.input("__tau_host_tool__", ...)`
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
  // 1. Host tools: open_file + GitHub watch/action tools
  registerHostTool(
    pi,
    "open_file",
    "Open File",
    "Open a file in the tau web UI file viewer (supports local:// URIs and workspace paths).",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "File path or local:// URI to open in the viewer." },
        line: { type: "number", description: "Optional 1-based line number to jump to." },
        endLine: { type: "number", description: "Optional 1-based end line number to highlight." },
      },
      required: ["path"],
    },
  );

  const githubTarget = {
    type: "string",
    description: "OWNER/REPO#N, or a https://github.com/OWNER/REPO/pull/N, /issues/N or /actions/runs/ID URL.",
  };

  registerHostTool(pi, "watch_github", "Watch GitHub", "Watch a GitHub PR, issue, or Actions workflow run for updates.", {
    type: "object",
    properties: { target: githubTarget },
    required: ["target"],
  });
  registerHostTool(pi, "unwatch_github", "Unwatch GitHub", "Stop watching a GitHub PR, issue, or workflow run.", {
    type: "object",
    properties: { target: githubTarget },
    required: ["target"],
  });
  registerHostTool(pi, "github_read", "Read GitHub", "Read metadata, comments, reviews, threads, checks, files, or diff for a GitHub target.", {
    type: "object",
    properties: {
      target: githubTarget,
      include: { type: "array", items: { type: "string" }, description: "Parts to include (summary, comments, reviews, threads, checks, files, diff)." },
      ids: { type: "array", items: { type: "string" }, description: "Optional item IDs to fetch." },
    },
    required: ["target"],
  });
  registerHostTool(pi, "github_comment", "GitHub Comment", "Post a comment on a GitHub PR or issue.", {
    type: "object",
    properties: {
      target: githubTarget,
      body: { type: "string", description: "Comment body in Markdown." },
      replyToId: { type: "string", description: "Optional review comment ID to reply to." },
    },
    required: ["target", "body"],
  });
  registerHostTool(pi, "github_resolve_thread", "Resolve GitHub Thread", "Resolve or unresolve a PR review thread.", {
    type: "object",
    properties: {
      target: githubTarget,
      threadId: { type: "string", description: "GraphQL thread ID." },
      resolved: { type: "boolean", description: "True to resolve, false to unresolve." },
    },
    required: ["target", "threadId"],
  });
  registerHostTool(pi, "github_run_list", "List GitHub Runs", "List recent GitHub Actions workflow runs.", {
    type: "object",
    properties: {
      repo: { type: "string", description: "OWNER/REPO" },
      branch: { type: "string" },
      workflow: { type: "string" },
      status: { type: "string" },
      limit: { type: "number" },
    },
    required: ["repo"],
  });
  registerHostTool(pi, "github_run_rerun", "Rerun GitHub Workflow", "Rerun a GitHub Actions workflow run.", {
    type: "object",
    properties: {
      target: githubTarget,
      failedOnly: { type: "boolean" },
    },
    required: ["target"],
  });
  registerHostTool(pi, "github_run_cancel", "Cancel GitHub Workflow", "Cancel a running GitHub Actions workflow run.", {
    type: "object",
    properties: { target: githubTarget },
    required: ["target"],
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
