import { apiErrorResponse, hostOfflineResponse, resolveSessionHostOr404 } from "@/lib/api-utils";
import { startRpcSession, getRpcSession, getRpcSessionKeys, WebRpcError, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { sessionSpawnTarget } from "@/lib/hosts/session-index";
import { RpcCommandError } from "@/lib/pi/rpc-process";
import { RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { attachUploads, forgetUploads, takeUploads, type OutboxUploadReceipt } from "@/lib/uploads";
import { runOutboxCommand } from "@/lib/message-outbox";
import { readClientMessageIds } from "@/lib/client-message-ids";
import { reconcileOutboxHandoffs } from "@/lib/outbox-handoff";
import type { MessageOrigin } from "@/lib/message-origin";

// Commands that ride whatever child is alive and never spawn or replace one:
// the side-question reads/cancel tau sends in the background (SSE connect,
// reconcile). Without a live process there is no running side question and
// nothing to cancel, so the reply is known without pi. Asking (`btw`) and opening the history start pi first.
export const NO_SPAWN_REPLIES: Record<string, unknown> = {
  get_btw_history: { records: [] },
  btw_cancel: { cancelled: false },
};

/** tau's own failures carry a stable code the client can localize; pi's
 * errors stay opaque English text. */
export function commandErrorResponse(error: unknown): Response {
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: "Agent command is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  // host_offline falls through to apiErrorResponse: 503 {hostOffline: true}.
  if (error instanceof WebRpcError && error.code !== "host_offline") {
    return Response.json({ error: error.message, code: error.code }, { status: 400 });
  }
  if (error instanceof RpcCommandError) {
    return Response.json({ error: error.message, code: error.code ?? "rpc_command_failed" }, { status: 400 });
  }
  return apiErrorResponse(error);
}

declare global {
  var __tauSendFences: Map<string, Promise<void>> | undefined;
}

// globalThis, like the rpc-manager registry: survives a `bun --hot` re-evaluation.
function sendFences(): Map<string, Promise<void>> {
  return (globalThis.__tauSendFences ??= new Map());
}

/** Everything POST /api/agent/[id] does once the body is parsed; shared with
 * the browser socket. `owner`: the caller's web session (lib/web-auth.ts
 * `requestOwner`), whose uploads a prompt may attach. Never throws: failures
 * become `commandErrorResponse`. */
export async function runAgentCommand(id: string, body: unknown, owner: string, trustedUploads?: OutboxUploadReceipt[], trustedOrigin?: MessageOrigin): Promise<Response> {
  let release = () => {}; // frees this command's send fence; idempotent
  try {
    const command = body as { type?: unknown; [key: string]: unknown } | null;
    if (typeof command?.type !== "string" || !command.type.trim()) {
      return Response.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }
    const type = command.type;
    if (command.origin !== undefined) {
      return Response.json({ error: "Message origin is server-owned.", code: "origin_not_allowed" }, { status: 400 });
    }
    // Held messages: stored and answered here; the outbox's dispatcher sends them to pi (lib/message-outbox.ts).
    if (type === "outbox_add" || type === "outbox_remove" || type === "outbox_scope") return await runOutboxCommand(id, command, owner);
    if (type === "get_client_message_status") {
      const ids = readClientMessageIds(command.clientMessageIds);
      if (!ids) return Response.json({ error: "clientMessageIds must contain 1 to 32 unique valid IDs", code: "invalid_client_message_ids" }, { status: 400 });
      return Response.json({ success: true, data: await reconcileOutboxHandoffs(id, ids) });
    }
    // Attached files go to the session's host first; nothing reaches pi when one fails (spec U3).
    const uploads = takeUploads(command, owner, trustedUploads);
    // Hold later wrapper selection as well as dispatch behind attachment preparation, so a Stop
    // cannot overtake the preparing prompt.
    // A moved session answers to several ids: a command through any of them waits.
    const held = getRpcSessionKeys(id).flatMap((key) => sendFences().get(key) ?? []);
    const prior = held.length ? Promise.all(held).then(() => {}) : undefined;
    if (uploads) {
      const gate = new Promise<void>((resolve) => (release = resolve));
      const fence = prior ? prior.then(() => gate) : gate;
      sendFences().set(id, fence);
      void fence.then(() => {
        if (sendFences().get(id) === fence) sendFences().delete(id);
      });
    }
    if (prior) await prior;
    const send = async (session: AgentSessionWrapper) => {
      const options = trustedOrigin ? { origin: trustedOrigin } : undefined;
      if (!uploads) return session.send(command, options);
      return session.withPendingCommand(async () => {
        let sending: Promise<unknown>;
        try {
          await attachUploads(uploads.ids, owner, session, command, uploads.receipts);
          sending = session.send(command, options);
        } finally {
          release();
        }
        const result = await sending;
        if (uploads) forgetUploads(uploads.ids, owner, uploads.receipts);
        return result;
      });
    };

    // Fast path: already-running session.
    const existing = getRpcSession(id);
    if (existing?.isAlive()) return Response.json({ success: true, data: await send(existing) });
    if (Object.hasOwn(NO_SPAWN_REPLIES, type)) return Response.json({ success: true, data: NO_SPAWN_REPLIES[type] });

    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    const { host } = resolved;
    const offline = hostOfflineResponse(host);
    if (offline) return offline;
    const target = await sessionSpawnTarget(id, host);
    if (!target) return Response.json({ error: "Session not found", code: "session_not_found" }, { status: 404 });

    // A cold set_model must reach pi before the saved model is restored:
    // spawning with only the session makes pi restore (or fail to restore)
    // the saved model before the RPC below ever runs (#277). Binding the requested
    // model at spawn time skips that restore check. Live children never
    // reach this path (they take the fast path above), and any other command
    // keeps the previous spawn behavior.
    const spawnModel =
      type === "set_model" &&
      typeof command.provider === "string" &&
      typeof command.modelId === "string" &&
      command.provider.trim() &&
      command.modelId.trim() &&
      !command.provider.startsWith("-") &&
      !command.modelId.startsWith("-") &&
      !/\s/.test(command.provider) &&
      !/\s/.test(command.modelId)
        ? `${command.provider}/${command.modelId}`
        : undefined;

    const { session } = await startRpcSession(id, target.sessionFile, target.cwd, undefined, target.recordedCwd, spawnModel, host, true);
    // This command inherits the open's preparation lease, so the shared child cannot idle out before it is sent.
    return await session.withPendingCommand(async () => {
      if (spawnModel) {
        // Try the normal RPC first: when it succeeds it also records the new
        // model in the session, so later spawns restore it without an override.
        // If set_model fails although the spawn already bound the model (seen
        // for a provider without credentials), the switch itself
        // succeeded: verify from live state and report success rather than a
        // false failure. A mismatch rethrows the RPC error, so a real failure
        // still surfaces.
        try {
          const result = await session.send(command);
          return Response.json({ success: true, data: result });
        } catch (error) {
          const state = (await session.send({ type: "get_state" })) as {
            model?: { id?: unknown; provider?: unknown };
          } | null;
          if (state?.model?.provider === command.provider && state?.model?.id === command.modelId) {
            return Response.json({ success: true, data: { id: command.modelId, provider: command.provider } });
          }
          throw error;
        }
      }
      const result = await send(session);
      return Response.json({ success: true, data: result });
    }, true);
  } catch (error) {
    return commandErrorResponse(error);
  } finally {
    release();
  }
}
