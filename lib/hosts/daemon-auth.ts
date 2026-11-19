// Host daemon only (Node, loaded through jiti): relative imports, no Bun APIs.
// The `auth` host op: this host's own pi logins (`<agent dir>/auth.json`), read and written by pi itself through tau's
// companion extension (`/tau_auth`, lib/pi/tau-extension.ts). Raw keys and tokens never leave pi; only a key the user
// types travels in, as one command argument.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { RpcProcess, type RpcFrame } from "../omp/rpc-process";
import { disposeUtilityRpc, runUtilityExtension } from "../omp/rpc-utility";
import { HostOpError, PROVIDER_ID_RE } from "./link-protocol";

/** One provider as pi reports it (`/tau_auth providers`). */
export interface HostAuthProvider {
  id: string;
  name: string;
  oauth: boolean;
  apiKeyLogin: boolean;
  /** The type of the credential stored in auth.json, if any. */
  stored: "api_key" | "oauth" | null;
  /** pi can authenticate it now: a stored login, an environment key or models.json. */
  configured: boolean;
  /** Configured in models.json, which tau edits in its own panel. */
  custom: boolean;
  models: number;
}

/** A login step for the browser, in the login SSE route's own event names. */
export type LoginEvent = Record<string, unknown> & { type: string };

const AUTHENTICATED_TTL_MS = 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** A poll waits this long for a new step; under the hub's 30 s op deadline. */
const POLL_WAIT_MS = 15_000;
/** A login nobody polls for this long has lost its server: it is cancelled. */
const ABANDONED_MS = 120_000;
const UTILITY_ARGS = ["--no-session", "--no-skills", "--no-mcp"];

interface Login {
  proc: RpcProcess;
  events: LoginEvent[];
  done: boolean;
  /** The pi dialog id of the open prompt, answered by `loginInput`. */
  promptId: string | null;
  wake: () => void;
  abandon: NodeJS.Timeout;
}

function provider(args: Record<string, unknown>): string {
  if (typeof args.provider !== "string" || !PROVIDER_ID_RE.test(args.provider)) throw new HostOpError(400, "invalid_request", "Invalid provider id");
  return args.provider;
}

/** pi's login events and prompts as the SSE route's events (`auth`, `device_code`, `prompt_request`, `select_request`, `progress`). */
function eventFor(frame: RpcFrame): LoginEvent | null {
  if (frame.type === "tau_auth_event" && typeof frame.event === "object" && frame.event !== null) {
    const event = frame.event as Record<string, unknown>;
    if (event.type === "auth_url") return { type: "auth", url: String(event.url ?? ""), instructions: typeof event.instructions === "string" ? event.instructions : null };
    if (event.type === "device_code") {
      return { type: "device_code", userCode: String(event.userCode ?? ""), verificationUri: String(event.verificationUri ?? ""), intervalSeconds: event.intervalSeconds ?? null, expiresInSeconds: event.expiresInSeconds ?? null };
    }
    if (typeof event.message === "string") return { type: "progress", message: event.message };
  }
  return null;
}

export function createDaemonAuth(options: { spawn?: (onFrame: (frame: RpcFrame) => void) => RpcProcess } = {}) {
  const spawn = options.spawn ?? ((onFrame) => new RpcProcess({ cwd: homedir(), extraArgs: UTILITY_ARGS, onFrame }));
  const logins = new Map<string, Login>();
  let authenticated: { at: number; ids: Promise<string[]> } | null = null;

  const providers = () => runUtilityExtension<{ providers: HostAuthProvider[] }>("tau_auth", { action: "providers" }).then((value) => value.providers);
  // A login or logout here changes what this host can authenticate; anything else (an edited auth.json, a new
  // environment) shows within the TTL.
  const changed = () => { authenticated = null; };

  function finish(login: Login, event: LoginEvent) {
    if (login.done) return;
    login.done = true;
    login.events.push(event);
    login.wake();
    clearTimeout(login.abandon);
    void login.proc.dispose();
  }

  function startLogin(id: string): { loginId: string } {
    const loginId = randomUUID();
    const login: Login = {
      proc: undefined as unknown as RpcProcess, events: [], done: false, promptId: null, wake: () => {},
      abandon: setTimeout(() => { logins.delete(loginId); finish(login, { type: "cancelled" }); }, ABANDONED_MS),
    };
    login.abandon.unref?.();
    login.proc = spawn((frame) => {
      if (frame.type === "ui_request" && frame.method === "input" && Array.isArray(frame.args) && frame.args[0] === "__tau_auth_prompt__" && typeof frame.id === "string") {
        let prompt: Record<string, unknown>;
        try { prompt = JSON.parse(String(frame.args[1])) as Record<string, unknown>; } catch { return; }
        login.promptId = frame.id;
        login.events.push(prompt.type === "select"
          ? { type: "select_request", message: String(prompt.message ?? ""), options: Array.isArray(prompt.options) ? prompt.options : [] }
          : { type: "prompt_request", message: String(prompt.message ?? ""), placeholder: typeof prompt.placeholder === "string" ? prompt.placeholder : null });
        login.wake();
        return;
      }
      const event = eventFor(frame);
      if (event) { login.events.push(event); login.wake(); }
    });
    logins.set(loginId, login);
    void (async () => {
      try {
        await login.proc.waitReady(60_000);
        await login.proc.callExtension("tau_auth", { action: "login", provider: id }, LOGIN_TIMEOUT_MS);
        changed();
        disposeUtilityRpc(); // its runtime still holds the old auth.json
        finish(login, { type: "success" });
      } catch (error) {
        finish(login, { type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return { loginId };
  }

  function loginFor(args: Record<string, unknown>): Login {
    const login = typeof args.loginId === "string" ? logins.get(args.loginId) : undefined;
    if (!login) throw new HostOpError(404, "login_no_pending", "No pending login");
    login.abandon.refresh();
    return login;
  }

  async function poll(args: Record<string, unknown>) {
    const login = loginFor(args);
    const after = typeof args.after === "number" && Number.isInteger(args.after) && args.after >= 0 ? args.after : 0;
    if (login.events.length <= after && !login.done) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_WAIT_MS);
        login.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    if (login.done) logins.delete(args.loginId as string);
    return { events: login.events.slice(after), done: login.done };
  }

  return {
    async run(args: Record<string, unknown>): Promise<unknown> {
      switch (args.action) {
        case "providers": return { providers: await providers() };
        case "authenticated": {
          if (!authenticated || Date.now() - authenticated.at > AUTHENTICATED_TTL_MS) {
            // A models.json provider counts: a local model server needs no key, and pi cannot tell it from a missing one.
            const ids = providers().then((list) => list.filter((entry) => entry.configured || entry.custom).map((entry) => entry.id));
            authenticated = { at: Date.now(), ids };
            ids.catch(() => { if (authenticated?.ids === ids) authenticated = null; });
          }
          return { providers: await authenticated.ids };
        }
        case "setApiKey": {
          if (typeof args.key !== "string" || !args.key.trim() || args.key.length > 4096) throw new HostOpError(400, "invalid_request", "Invalid API key");
          await runUtilityExtension("tau_auth", { action: "api_key", provider: provider(args), key: args.key.trim() });
          changed();
          return {};
        }
        case "logout":
          await runUtilityExtension("tau_auth", { action: "logout", provider: provider(args) });
          changed();
          return {};
        case "loginStart": return startLogin(provider(args));
        case "loginPoll": return poll(args);
        case "loginInput": {
          const login = loginFor(args);
          if (typeof args.value !== "string") throw new HostOpError(400, "invalid_request", "Invalid login input");
          if (login.promptId === null) throw new HostOpError(409, "login_not_waiting", "The login is not waiting for input");
          login.proc.sendFrame({ type: "ui_response", id: login.promptId, value: args.value });
          login.promptId = null;
          return {};
        }
        case "loginCancel": {
          const login = typeof args.loginId === "string" ? logins.get(args.loginId) : undefined;
          if (login) { logins.delete(args.loginId as string); finish(login, { type: "cancelled" }); }
          return {};
        }
        default: throw new HostOpError(400, "invalid_request", "Unknown auth action");
      }
    },
    stop() {
      for (const login of logins.values()) finish(login, { type: "cancelled" });
      logins.clear();
      disposeUtilityRpc();
    },
  };
}
