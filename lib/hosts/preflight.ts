import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentEnvOverrides } from "../pi/agent-env";
import { getPiVersion, resolvePiBin } from "../pi/pi-cli";
import { spawnPiTransport } from "../pi/rpc-process";

// `tau preflight`: start pi the way a host starts one for a new session (same resolver, same
// spawn, plus --no-session in a scratch cwd) and wait for its get_state answer. Updaters run it on a candidate
// release before they switch to it. Deploy scripts grep its output for the literal success prefix below.
// shortcut: no credentials env, --resume/--tools or cluster config as the daemon adds; upgrade if those break a start.

/** Only this module embeds it (the scratch cwd's prefix): the host updater finds the command in a compiled release
 * by it (update-worker.ts holds it base64-encoded) and refuses a release without it. */
export const PREFLIGHT_MARKER = "tau-preflight-scratch-";

export async function runPreflight(timeoutMs = 30_000): Promise<number> {
  const fail = (bin: string, reason: string) => {
    console.error(`preflight failed: ${bin}: ${reason}`);
    return 1;
  };
  const bin = resolvePiBin();
  if (!bin) return fail(process.env.TAU_PI_BIN || "pi", "not found");
  if (process.platform !== "win32") {
    try { accessSync(bin, constants.X_OK); } catch { return fail(bin, "not executable"); }
  }
  const cwd = mkdtempSync(join(tmpdir(), PREFLIGHT_MARKER));
  try {
    const transport = spawnPiTransport({ cwd, env: getAgentEnvOverrides(), extraArgs: ["--no-session"] });
    let stderr = "";
    const tail = () => (stderr.trim() ? `: ${stderr.trim().slice(-500)}` : "");
    const exited = Promise.withResolvers<void>();
    // null: hello seen; else why it failed.
    const outcome = Promise.withResolvers<string | null>();
    transport.onStderr((chunk) => { stderr = (stderr + chunk).slice(-2000); });
    transport.onExit((code, signal) => {
      outcome.resolve(`exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}${tail()}`);
      exited.resolve();
    });
    transport.onLine((line) => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; /* not a frame */ }
      if (frame?.type === "response" && frame?.id === "preflight") {
        outcome.resolve(frame.success === true ? null : `get_state failed: ${String(frame.error ?? "unknown error")}`);
      }
    });
    transport.write('{"id":"preflight","type":"get_state"}\n', (err) => {
      if (err) outcome.resolve(`stdin write failed: ${err.message}`);
    });
    const timer = setTimeout(() => outcome.resolve(`no hello within ${timeoutMs / 1000} s${tail()}`), timeoutMs);
    const failure = await outcome.promise;
    clearTimeout(timer);
    // As RpcProcess.dispose: closed stdin lets pi shut down cleanly; then nothing of its tree may outlive the check.
    transport.endInput();
    await Promise.race([exited.promise, sleep(2_000, undefined, { ref: false })]);
    transport.killTree(true);
    // Windows keeps the scratch cwd busy until the child is gone.
    await Promise.race([exited.promise, sleep(5_000, undefined, { ref: false })]);
    if (failure) return fail(bin, failure);
    console.log(`preflight ok: ${bin} ${(await getPiVersion()) ?? "(version unknown)"}`);
    return 0;
  } catch (error) {
    return fail(bin, error instanceof Error ? error.message : String(error));
  } finally {
    // Best effort: a scratch dir still locked (Windows) must not turn the verdict into a crash.
    try { rmSync(cwd, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left in tmpdir */ }
  }
}
