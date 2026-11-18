// Dev entry (`npm run dev`): API plus the SPA from Bun's HTML import with HMR, bundled in memory; never reads dist/.
import html from "../app/index.html";
import { buildEventStreamWorker, clientEnv } from "./client-env";

declare global {
  var __tauRegistered: Promise<void> | undefined;
  var __tauDevServer: Bun.Subprocess | undefined;
}

const root = process.env.TAU_PACKAGE_DIR ?? process.cwd();
// Bundled on each start (and each --hot re-evaluation); its hash, like a build's, versions the worker's URL.
const worker = await buildEventStreamWorker(root);
const env = clientEnv(root, worker);
// Empty commit fields are initialized values; a new worker hash during hot reload must not start a second listener.
if (Object.keys(env).some((name) => process.env[name] === undefined)) {
  // bunfig.toml's [serve.static] env inlines TAU_PUBLIC_* from the environment Bun started with, so setting them
  // now is too late: run once more with them set and the same flags (--hot). The guard survives a --hot re-evaluation.
  const child = (globalThis.__tauDevServer ??= Bun.spawn([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  }));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  process.exit(await child.exited);
}

Object.assign(process.env, { NODE_ENV: "development" });
const { parseListenArgs, startServer } = await import("./app");
const server = startServer({ ...parseListenArgs(Bun.argv.slice(2), 30188), dev: true, root, html, worker });
// `bun --hot` re-evaluates this file on every edit; register() must run once per process.
globalThis.__tauRegistered ??= import("../instrumentation.node").then(({ register }) => register());
await globalThis.__tauRegistered;
console.log(`[tau] Ready on ${server.url.origin}`);
