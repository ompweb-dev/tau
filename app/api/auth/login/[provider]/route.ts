import { afterAuthChange, hostIdOf, providerIdOr400 } from "@/lib/host-auth";
import { authOp } from "@/lib/hosts/hub";
import { isRecord } from "@/lib/type-guards";

/**
 * Interactive account login on `?hostId=` (default this machine), run by that host's daemon in a pi of its own
 * (lib/hosts/daemon-auth.ts). The SSE stream keeps pi-web's event names (auth, device_code, prompt_request,
 * select_request, progress, success, error, cancelled) so the client flow is unchanged; the POST handler feeds the
 * user's pasted code or chosen option back to the daemon.
 */

const HEARTBEAT_MS = 30_000;
/** A long poll waits up to 15 s on the daemon; this leaves room for the link. */
const POLL_TIMEOUT_MS = 25_000;

interface PendingLogin {
  provider: string;
  hostId: string;
  loginId: string;
}

// Registry survives dev-server hot reload; the SSE stream registers its token, the POST handler resolves it.
declare global {
  var __tauLoginRegistry: Map<string, PendingLogin> | undefined;
}

function getLoginRegistry(): Map<string, PendingLogin> {
  if (!globalThis.__tauLoginRegistry) globalThis.__tauLoginRegistry = new Map();
  return globalThis.__tauLoginRegistry;
}

// POST /api/auth/login/[provider] — frontend sends redirect URL, auth code or chosen option
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const body: unknown = await req.json().catch(() => null);
  const token = isRecord(body) && typeof body.token === "string" ? body.token : "";
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "";
  if (!token || !code) {
    return Response.json({ error: "token and code required", code: "login_token_code_required" }, { status: 400 });
  }
  const pending = getLoginRegistry().get(token);
  if (!pending) {
    return Response.json({ error: "No pending login for token", code: "login_no_pending" }, { status: 404 });
  }
  // Exact provider association: provider ids may share prefixes ("openai" vs "openai-codex").
  if (pending.provider !== provider) {
    return Response.json({ error: "Token does not match provider", code: "login_token_mismatch" }, { status: 400 });
  }
  try {
    await authOp(pending.hostId, { action: "loginInput", loginId: pending.loginId, value: code });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
  return Response.json({ ok: true, provider });
}

// GET /api/auth/login/[provider]?hostId= — SSE stream for the login flow
export async function GET(
  req: Request,
  { params, disableIdleTimeout }: { params: Promise<{ provider: string }>; disableIdleTimeout: () => void }
) {
  const { provider } = await params;
  const invalid = providerIdOr400(provider);
  if (invalid) return invalid;
  disableIdleTimeout();
  const hostId = hostIdOf(req);
  const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const registry = getLoginRegistry();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // OAuth flows sit idle while the user is in the browser; keep the SSE connection alive past proxy idle timeouts.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      let loginId: string | null = null;
      const cancel = () => {
        if (loginId) void authOp(hostId, { action: "loginCancel", loginId }).catch(() => {});
      };
      req.signal.addEventListener("abort", cancel);
      try {
        const started = await authOp(hostId, { action: "loginStart", provider });
        if (!isRecord(started) || typeof started.loginId !== "string") throw new Error("The host sent an invalid login");
        loginId = started.loginId;
        if (req.signal.aborted) cancel();
        registry.set(token, { provider, hostId, loginId });
        let after = 0;
        let outcome: string | null = null;
        while (!outcome && !req.signal.aborted) {
          const polled = await authOp(hostId, { action: "loginPoll", loginId, after }, POLL_TIMEOUT_MS);
          if (!isRecord(polled) || !Array.isArray(polled.events)) throw new Error("The host sent an invalid login step");
          after += polled.events.length;
          for (const event of polled.events) {
            if (!isRecord(event) || typeof event.type !== "string") continue;
            if (event.type === "success" || event.type === "error" || event.type === "cancelled") outcome = event.type;
            // The browser answers a prompt with this stream's token.
            send(event.type === "auth" || event.type === "prompt_request" || event.type === "select_request" ? { ...event, token } : event);
          }
        }
        if (outcome === "success") afterAuthChange(hostId, provider, true);
        if (!outcome) send({ type: "cancelled" });
      } catch (error) {
        if (req.signal.aborted) send({ type: "cancelled" });
        else send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        req.signal.removeEventListener("abort", cancel);
        registry.delete(token);
        clearInterval(heartbeat);
        closed = true;
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
