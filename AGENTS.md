# tau - Development Notes

tau is a web UI for the pi coding agent (`@earendil-works/pi-coding-agent`, developed against 1.5.2). It is a fork of
ompweb, but a separate product: it shares no state, protocol history or installation with ompweb.

## Quick Start

```bash
npm run dev            # Bun server with hot reload (HMR for the SPA), 127.0.0.1:30188 (dev:lan: 0.0.0.0)
npm run build          # bundle the SPA into dist/ (scripts/build-client.ts)
npm start              # serve dist/ + the API, 127.0.0.1:30187 (start:lan: 0.0.0.0)
npm test               # bun test --parallel --timeout 30000 over app bin components hooks lib scripts server tests
npm run smoke          # start the built server and its local host and check them (-- --package <dir> | --binary <path>; --pi <path>)
npm run build:binary   # build, then compile release/tau-<os>-<arch>/ and its .tar.gz/.zip (-- --target bun-<os>-<arch>)
npm run typecheck && npm run lint
npm run release:check  # typecheck, lint, test, build, smoke
```

Live sessions need pi: `npm i -g @earendil-works/pi-coding-agent`, or point `TAU_PI_BIN` at a pi binary or wrapper
script (`lib/pi/pi-cli.ts`: `TAU_PI_BIN`, else `pi` on `PATH`; a miss is re-probed after 30 s). Without it a host
reports `pi-missing` and live commands fail with `pi_not_found`; session browsing still works.

---

## Architecture

tau never imports pi's SDK (or any `@earendil-works/*` package): every live session is a `pi --mode rpc` child,
started with tau's companion extension `--extension lib/pi/tau-extension.ts`. See `DESIGN.md` for the porting contract.

```
Browser                    Bun server (server/app.ts)                   tau host daemon (Node)        pi child
  │                               │                                            │                         │
  ├─ GET /api/sessions ──────────▶ listSessions op ─────── host link (WS) ───▶ reads ~/.pi/agent/sessions │
  ├─ SharedWorker ─ GET /api/events ▶ ONE multiplexed SSE per browser          │                         │
  │   (all tabs)    POST /api/events ▶ subscribe running/session/file/...      │                         │
  ├─ send message ──────────────▶ POST /api/agent/[id]                         │                         │
  │                               │  startRpcSession() ── open/spawn ────────▶ │ pi --mode rpc ─────────▶│
  │                               │  sendCommand({type:"prompt"}) ───────────▶ │  --extension tau-extension.ts
  │                               │  onFrame() ◀── stdout JSONL frames ──────── │ ◀──────────────────────│
  │◀── event: s<n> data: {...} ───│                                            │                         │
```

- The launcher (`bin/tau.js`), the host daemon (`bin/tau-host.js`, `tau host`) and the tray run on Node. The launcher
  spawns `bun server/main.ts` (Bun from `bin/bun-runtime.js`: the npm `@oven/bun-*` binary, else `bun` on `PATH`),
  which serves the SPA from `dist/`, the API routes and the password gate in one process. The daemon and tray must
  not use Bun APIs. The compiled binary (`server/binary.ts`) is one Bun program: the server in its own process, plus
  `tau host`, `tau preflight` and `tau hash-password`.
- **Every machine runs sessions through a daemon**, this one included: main never spawns a session pi. The web server
  links to this machine's own `tau host` daemon like to any remote host (see "Remote hosts"). `startRpcSession()`
  (`lib/rpc-manager.ts`) asks the session's `Host` (`getHost(id)`, `lib/hosts/hub.ts`) for an `RpcTransport`; the
  daemon spawns pi with `localHost` (`lib/hosts/local-host.ts`), and `lib/pi/rpc-process.ts` (`RpcProcess`) speaks
  pi's RPC over it. The one deliberate pi child on main is the utility process (`lib/pi/rpc-utility.ts`:
  `--no-session --no-skills --no-mcp`, idle-killed after 5 min) for global reads such as `get_available_models`.
- **Session browsing** is pure Node parsing of session `.jsonl` files (`lib/session-reader.ts`,
  `lib/pi/session-files.ts`), run in the owning host's daemon (`host.sessionOps`), never a pi process.
- The `rpc` in `rpc-manager.ts`/`RpcProcess`/`RpcTransport` is pi's RPC mode.

### pi's RPC and what tau adds

pi speaks JSON lines on stdin/stdout: commands answered by `{type:"response", id, success, data|error}`, and events
(`agent_start`, `agent_end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`,
`queue_update`, `agent_settled`, `extension_ui_request`, ...). `RpcProcess` normalizes them:

- `agent_settled` is re-emitted as tau's `session_settled` (the end of a run and everything it continued into).
- `get_state` answers are completed with what tau reads and pi does not report (`withQueueAndSettlement`):
  `queuedMessages` (from the last `queue_update`), `queuedMessageCount` (pi's `pendingMessageCount`), `isSettled`,
  `supportsClientMessageIds`.
- Extension UI dialogs (`select`, `confirm`, `input`, `editor`) become tau `ui_request` frames and their answers
  `extension_ui_response`; `notify` becomes a `notice`. `input` dialogs titled `__tau_host_tool__` / `__tau_ask__`
  become `host_tool_call` / `ui_request{method:"askDialog"}`.
- The extension talks back through `setWidget("tau", [<json>])` frames: `tau_hello`, `tau_message_identity`,
  `tau_queue`, `tau_reply` (the answer to a `callExtension`), `btw_*`, `tau_auth_event`.
- tau calls the extension with `prompt` commands `/tau_<name> <json>` (`callExtension`; the daemon recognizes them,
  `isExtensionCommand`, and never treats them as user messages):
  - `/tau_host_tools`: register the server's host tools (`set_host_tools`).
  - `/tau_meta`: message identity and origin (`name`, `status`, `clear`), journaled as `client-message-entry` and
    `client-message-resolution` custom entries.
  - `/tau_btw`: side questions (ask, cancel, history; records persisted as `tau_btw` custom entries).
  - `/tau_edit`: history Edit (`navigateTree(entryId, {summarize:false})`).
  - `/tau_auth`: provider logins through pi's `ModelRuntime` (`providers`, `login`, `api_key`, `logout`).
- pi's wire `message_update` is delta-only and carries no message or id: the daemon shapes it (`piStreamFrame`, see
  "Streaming message updates").
- pi-subagents (the pi package) needs no extension bridge: `lib/pi/subagent-bridge.ts` turns its `subagent` tool
  progress and `subagent-async` widget snapshots into tau's `subagent_lifecycle`/`subagent_progress` frames and
  answers `get_subagents`.
- `TAU_NO_EXTENSION=1` starts pi without the extension (tests only). `resolveTauExtensionPath` looks under
  `TAU_PACKAGE_DIR`, then beside `rpc-process.ts`, never in the session's cwd. Without that flag a missing extension
  refuses the spawn (`TAU_EXTENSION_MISSING`): pi would read every `/tau_*` call as a prompt and send it, an API key
  included, to the model. With the flag `RpcProcess.callExtension` refuses every call for the same reason; it reads the
  calling process's environment, so the flag is for single-process tests and never for a daemon.

### `lib/pi/` (pi foundations)

- `paths.ts`: pi's directory rules. Agent dir `~/.pi/agent` (`PI_CODING_AGENT_DIR` overrides it); sessions `<agent dir>/sessions/--<cwd with / \ : as ->--/` (`getSessionDirNameForCwd`); archive
  `<agent dir>/../archive/sessions`; `settings.json`, `models.json`; `getTauDataDir()` (`<agent dir>/tau`); `sessionLocalRoot`
  (a session's local directory, where uploads land: `<session file without .jsonl>/local`, Windows long paths
  `<tmp>/tau-local/<id>`).
- `pi-cli.ts`: `resolvePiBin`, `getPiVersion` (cached by binary fingerprint), `wrapWindowsScript` (`.cmd`/`.bat` via
  `cmd.exe /c`), `PI_NOT_FOUND`.
- `rpc-process.ts` / `rpc-transport.ts`: `RpcProcess` (see above) over an `RpcTransport` byte pipe
  (`spawnLocalRpcTransport` in the daemon, `RemoteRpcTransport` in `hub.ts` on main).
- `tau-extension.ts`: the companion extension (loaded by pi, not by tau's server).
- `rpc-utility.ts`: the utility pi (`runUtilityCommand`, `runUtilityExtension`).
- `session-files.ts`: session file reading/writing, listing walk (`listSessionFiles`), migrations; `archive.ts`:
  archive and restore.
- `settings-config.ts` (allow-listed keys of pi's global `settings.json`), `models-config.ts` (`models.json`),
  `mcp-config.ts` (MCP configuration files), `plugins-cli.ts` (`pi list` parsing), `agent-env.ts` /
  `agent-env-policy.ts` (extra environment variables for pi children), `subagent-bridge.ts`.

### tau's own files

- `<agent dir>/tau/`: `hosts.json`, `pools.json`, `pool-starts.json`, `host.json` (the daemon's links),
  `host-control.json`, `host-running.json`, `uploads/`, `upload-retention.json`, `outbox.db`, the notification
  store, `github-watches.sqlite`, Actions receipts, `archive-restore-locks.sqlite`, `server-upgrades/`,
  `web-auth-secret.json`, `transport-metrics.jsonl`, `cluster-config/`, `own-config/`.
- `<agent dir>/tau-settings.json` (+ `tau-settings.lock.sqlite`): server settings (`lib/web-settings.ts`).
- `<agent dir>/projects.json`: managed projects. `<agent dir>/tau-interrupted-sessions-<pid>.json`: auto-resume lists.
- `<agent dir>/tau/media/`: tool-result image copies and thumbnails; `<agent dir>/tau/diagnostics.log`: crash/stall journal.

---

## File Map

```
server/
  main.ts           production entry: sets NODE_ENV, then `startProduction` (app.ts); prints the `Ready on` line the launcher waits for
  binary.ts         the compiled `tau`: launcher checks and `startProduction` in-process, `host` (host-cli.ts), `preflight`, `hash-password`
  dev.ts            dev entry (`bun --hot`): HTML import with HMR; re-runs itself once with TAU_PUBLIC_* set so bunfig.toml can inline them
  app.ts            `startServer`: Bun.serve + route table + gate + SPA fallback + the one websocket handler; `startProduction`
  routes.ts         the API route table (see "Adding an API route"); `routePattern`, `dispatch`
  http.ts           `finalizeResponse` (security headers, gzip for pages and static files, never /api/), `serveFile`, `renderIndex`
  client-env.ts     build-time constants for the browser bundle; `buildEventStreamWorker`
app/
  index.html        SPA shell and bundler entry; #root holds static copies of RouteLoadingFallback and LoginForm's first render
  client.tsx        browser entry: `LoginForm` on /login, else `AppShell` (a path check, no router)
  boot.ts           runs first: installs the sidebar history bridge before AppShell registers popstate listeners
  globals.css       design tokens and global styles
app/api/
  sessions/route.ts                    GET all sessions, every host
  sessions/search/route.ts             GET ?q= NDJSON { scores } batches (titles + per-host transcripts)
  sessions/import/route.ts             POST import a session .jsonl
  sessions/archive/route.ts            GET archives of every host | POST restore (see "Session archive and restore")
  sessions/[id]/route.ts               GET/PATCH/DELETE a session; GET ?meta=1 answers the navigation shape (tree + leaf, no transcript), ?includeState=alive the split liveness shape (`running` = a turn in flight, `alive` = the child exists)
  sessions/[id]/state/route.ts         GET live state; always carries `outbox`, `outboxSettledIds`, `outboxScope`
  sessions/[id]/context/route.ts       GET ?leafId= context of one leaf (read-only branch view); strong ETag, 304 on a matching If-None-Match
  sessions/[id]/entries/[entryId]/thinking/route.ts  GET one deferred thinking block
  sessions/[id]/matches/route.ts       GET ?q=&limit= best search hits in the active conversation
  sessions/[id]/export/route.ts        GET exported HTML (`tau-session-<id>.html`; a remote session's always as an attachment)
  sessions/[id]/archive/route.ts       POST stop the live child, then archive on the session's host
  sessions/[id]/auto-name/route.ts     POST stored title, else one derived from the first user message (`generated` always false)
  sessions/[id]/subagents/route.ts, subagents/[subagentId]/route.ts   subagent roster history and transcripts
  agent/new/route.ts                   POST start a session (host, pool or cluster target)
  agent/[id]/route.ts                  GET state (?systemPrompt=0 drops the system prompt from the poll) | POST any agent command (`runAgentCommand`)
  agent/[id]/bash-output/route.ts      GET streamed `!` command output
  events/route.ts                      GET the multiplexed SSE | POST subscribe/unsubscribe channels
  transport-metrics/route.ts           GET { now } (clock probe) | POST { samples } → <agent dir>/tau/transport-metrics.jsonl
  hosts/route.ts                       GET hosts | POST { label } → token once | PUT { pools } | PATCH { id, label?, allowAgentStart? } or { poolId, label } | DELETE ?id= revoke
  hosts/link/route.ts                  GET the application link WebSocket (bearer checked before the upgrade; ungated)
  hosts/maintenance/route.ts           GET maintenance API v1 discovery and WebSocket (bearer; ungated)
  hosts/[id]/maintenance/route.ts      GET a host's maintenance status (gated)
  hosts/[id]/updates/route.ts          GET update status | POST { target: "tau", version, force? }
  hosts/[id]/cluster/route.ts          PUT { projectsRoot } join the cluster, then `apply` | DELETE leave, then `restore`
  hosts/cluster-config/manifest/route.ts, file/[hash]/route.ts   the master's configuration for members (host token; ungated)
  auth/providers, auth/all-providers, auth/login/[provider], auth/api-key/[provider], auth/accounts/[provider]   per-host pi logins (?hostId=)
  models/route.ts                      GET models (utility pi) | models-config/route.ts GET/PUT models.json | models-config/catalog/route.ts GET models.dev search
  pi-settings/route.ts                 GET/PUT allow-listed keys of pi's settings.json
  pi-version/route.ts                  GET the installed pi version
  web-settings/route.ts                GET/PUT tau's server settings
  web-auth/session/route.ts            POST password login session
  app-update/route.ts, app-update/notes/route.ts   coordinated server upgrade (prepare/commit) and release notes
  windows-service/route.ts             Windows service status/actions
  mcp/route.ts                         GET/POST/PUT/DELETE MCP server configuration (no live status)
  plugins/route.ts                     GET/POST pi packages (`pi list/install/remove/update`)
  skills/route.ts, check, update, install, search   skill listing, disable-model-invocation toggle, updates, `npx skills add`, skills.sh search
  projects/route.ts                    GET registered+discovered projects | POST add | DELETE hide
  projects/clone/route.ts              POST clone (NDJSON progress) | DELETE cancel
  worktrees/route.ts                   GET/POST/DELETE git worktrees on the owning daemon
  files/[...path], file-index, file-search, git/status, git/diff, cwd/browse, cwd/validate, default-cwd, home, github-repo   workspace reads (daemon-owned)
  media/[hash]/route.ts                GET tool-result image by sha256 (?thumb=1 → 480px WebP)
  notifications/devices, presence, history, answer   push devices, presence reports, notification history, answering a pending dialog
  stt/route.ts, stt/[jobId]/route.ts, stt/[jobId]/audio/route.ts   transcription jobs
  uploads/route.ts, uploads/[id]/route.ts    composer uploads (start/resume, chunks, abort)
  usage/route.ts, manifest/route.ts    usage report; web app manifest

lib/
  pi/                    pi foundations (above)
  rpc-manager.ts         session wrappers (`AgentSessionWrapper`), registry, `startRpcSession`, command handling
  agent-command.ts       `runAgentCommand`: the one command path behind POST /api/agent/[id]
  agent-client.ts        agent commands from the tab (POST /api/agent/[id]); records `action` samples
  agent-tools.ts, agent-tool-hosts.ts   server-run agent tools (new_session, send_to_session, list_sessions, ...) and the host-confirm rule
  github/                GitHub agent tools: gh.ts, api.ts, events.ts, watch-store.ts, watcher.ts, tools.ts, actions.ts, action-tools.ts, action-receipts.ts
  hosts/                 hosts, link, maintenance API, daemon (see "Remote hosts"); notable: hub.ts, daemon.ts, daemon-link.ts,
                         daemon-channels.ts, channel-lifecycle.ts, shared-requests.ts, stream-snapshot.ts, pending-requests.ts,
                         maintenance-protocol.ts, maintenance-hub.ts, daemon-maintenance.ts, daemon-auth.ts, preflight.ts,
                         cluster*.ts, daemon-cluster-config.ts, pools.ts, pool-starts.ts, capacity.ts, host-control.ts,
                         local-daemon-start.ts, local-daemon-supervisor.ts, workspace-*.ts, updates.ts, update-worker.ts
  event-stream.ts        tab side: EventSource-shaped streams over the shared worker; `uploadFile`; `addToOutbox`
  event-stream-worker.ts the SharedWorker: one /api/events EventSource per browser, the outbox's IndexedDB leg, metrics
  event-stream-hub.ts    server channels for /api/events; backpressure merging
  event-stream-protocol.ts  wire contract shared by hub, route and facade; `NO_SPAWN_REPLIES`
  message-outbox.ts, message-outbox-schema.ts, outbox-handoff.ts, client-message-ids.ts, message-origin.ts   message outbox and identity
  message-delta.ts, message-update-coalescer.ts   streaming deltas (server and browser)
  session-reader.ts      session parsing, path cache, `buildSessionContext`, `listAllSessions`
  session-search.ts, session-content-search.ts, session-search-matches.ts, session-match-listing.ts   sidebar search
  session-resume.ts      per-web-server auto-resume (transports without host-owned lifecycle)
  session-local-files.ts daemon side: a session's local directory and whether a path lies in it (the file gate)
  file-access.ts, file-authorization.ts   allowed roots and the file gate; `isPiSecretFile`
  file-paths.ts          `getFileApiUrl` and path encoding
  media-cache.ts         tool-result images → /api/media URLs
  uploads.ts             main side of composer uploads (registry, relay to the daemon)
  upload-limits.ts       upload limits (browser-safe)
  btw.ts                 /btw records and order-safe merging
  subagent-types.ts, subagent-history.ts, subagent-format.ts, task-result-details.ts   subagents
  notification-events.ts, notification-hub.ts, notification-store.ts, notification-history.ts, notification-client.ts   notifications
  host-auth.ts           server side of the auth routes (per-host `auth` op)
  models-cache.ts, model-catalog.ts, model-scope.ts   models list cache, models.dev catalog
  skills-service.ts, skill-lock.ts, skill-updates.ts   skill discovery mirroring pi
  project-registry.ts, project-ordering.ts, pooled-projects.ts, worktree.ts, git-clone.ts, project-clone.ts   projects
  web-settings.ts, web-auth.ts, web-auth-secret.ts, web-password-hash.ts, request-security.ts   settings and auth gate
  self-update.ts, server-update-worker.ts, upgrade-plan.ts, upgrade-process.ts, upgrade-types.ts, npm-update.ts, update-policy.ts   server upgrades
  stt.ts, stt-jobs.ts    speech-to-text (stt-jobs.ts is server-only)
  transport-metrics.ts, transport-stats.ts   transport samples and statistics
  usage-db.ts, usage-service.ts, usage-rates.ts   usage report
  archive-restore-lock.ts   restore claims (SQLite)
  dynamic.tsx, navigation.ts   `dynamic()` over React.lazy; `useRouter`/`useSearchParams` over the History API
  navigation-history.ts  back/forward stack and shortcut matcher
  chat-fork.ts, chat-transcript-plan.ts, normalize.ts, types.ts, pi-types.ts   chat helpers and shared types
  project-command-env.ts child environments (`createChildProcessEnvironment`, `sanitizeProjectCommandEnvironment`)

components/              React UI (AppShell, ChatWindow, ChatInput, MessageView, SessionSidebar, ComposerPanels, BtwPanel,
                         HostsConfig, HostUpdates, ModelsConfig, ProviderAccounts, McpConfig, PluginsConfig, SkillsConfig,
                         SettingsConfig, ConnectionDiagnostics, NotificationBell/List, LocalDaemonBanner, ExtensionDialog, ...)
components/ui/           shared primitives on @base-ui/react: primitives.tsx, field.tsx, toast.tsx, ToggleSwitch.tsx
hooks/                   useAgentSession(-stream/-sync/-queue/-notices), useBtw, useHostRows, useNotifications, useTheme,
                         useNavigationHistory, useChatSearchHighlights, useDictation, useSpeechSynthesis, ...

bin/
  tau.js              launcher (Node); `tau preflight` through jiti
  tau-host.js         `tau host [login|logout|status|drain|resume]`: loads lib/hosts/host-cli.ts through jiti; token from stdin, never argv
  bun-runtime.js      resolves Bun (npm `@oven/bun-*`, else PATH, minimum version)
  tau-tray.js, linux-tray.js, tau-systemd.js, tau-launchd.js   tray and service installers

scripts/
  build-client.ts, tailwind-plugin.ts   SPA bundle (bun-plugin-tailwind minus its color-mix() polyfill)
  build-binary.ts, build-release-binaries.sh, licenses.ts, check-host-release-archive.ts   compiled releases
  smoke.ts            `npm run smoke`: built server (or package/binary) + its local host + a live `pi --mode rpc` session + SSE
  transport-metrics.ts   summary of transport and link samples (`--since 2h`, `--until`, `--client`, `--session`, `--file`)
  link-hol-probe.ts   head-of-line load on one host link

tests/                setup-dom.mjs, mock-builtin.mjs, fake-indexeddb.mjs, isolate-tmp.mjs (preload), fixtures
proxy.ts              the password gate (`UNGATED`)
instrumentation.node.ts   server startup: local host link, cluster sync, auto-resume, shutdown
bunfig.toml           dev bundling plugins, TAU_PUBLIC_* inlining, test preload
```

---

## Key Design Decisions & Traps

### Adding an API route
1. Create `app/api/<path>/route.ts` exporting `GET`/`POST`/`PUT`/`PATCH`/`DELETE` handlers (plain `Request` → `Response`; dynamic segments `[id]`, catch-all `[...path]`).
2. Add one `import * as x from "@/app/api/<path>/route"` and one entry to `ROUTE_MODULES` in `server/routes.ts`; the key is the directory under `app/api` (`"sessions/[id]"`).
3. `server/routes.test.ts` fails when the table and the files on disk differ, and when a route module exports anything but method handlers.

The table is static imports, not a runtime glob, so `bun build --compile` bundles every handler. `dispatch` answers HEAD from `GET`, OPTIONS and a missing method (405 with `allow`), passes `params` as a promise (plus `disableIdleTimeout` and `upgrade`), and turns a throw into a 500 JSON body.

### Bun server (`server/`)
- Bun's 10 s `idleTimeout` stays on: it reaps stalled sockets, and it also cuts a handler still working after 10 s. So `handle` (`server/app.ts`) calls `server.timeout(request, 0)` for an `/api/` request that `proxy()` reports as `"authenticated"` (never `"public"`) and restores the 10 s once the handler returns or throws (the setting outlives the response on a keep-alive socket). A handler whose response stays open without traffic (SSE `/api/events`, the login SSE, clone/search/bash-output/file streams) calls `disableIdleTimeout` from the route context; a new stream must do the same, or it is cut after 10 s idle.
- WebSockets: the route context carries `upgrade` (`server.upgrade(request, { data })`), and `server/app.ts` has one `websocket` handler: `ws.data.kind === "maintenance"` goes to `maintenanceSocket` (`maintenance-hub.ts`), anything else to `hostLinkSocket` (`hub.ts`). An upgraded socket is outside the HTTP idle timeout. A handler that upgraded returns `undefined`, which passes through without `finalizeResponse` or the idle-timeout restore. Browsers get no WebSocket: the browser connection is SSE only.
- `maxRequestBodySize` stays at Bun's 128 MiB default, above the upload chunk and command caps; do not lower it.
- Bun's router matches the **raw** path, while `request.url` is normalized (`..` and `%2e%2e` resolved). The gate and handlers read `request.url`, so each route re-matches the normalized path against its own `URLPattern` after the gate and answers 404 if it no longer matches. Never serve a gated route under an ungated path.
- Redirects carry a relative `Location` (`request.url` is always `http://` under Bun).
- `Response.redirect()` headers are immutable; `finalizeResponse` copies every answer into a fresh `Response` for the security headers and gzip. Do not mutate a handler's response headers elsewhere.
- `globalThis` state survives `bun --hot` re-evaluation, and `register()` (`instrumentation.node.ts`) runs once per process behind a `globalThis` guard in `server/dev.ts`. New server singletons use the `globalThis` registry pattern of `rpc-manager.ts`.
- Dev serves the SPA from the HTML import with HMR and re-runs itself once with `TAU_PUBLIC_*` set, because `bunfig.toml` inlines them from the environment Bun started with. Dev pages carry `script-src blob:` in their CSP (HMR); production does not.
- `TAU_PACKAGE_DIR` (set by the launcher) is the root for `dist/`, `public/`, KaTeX and the companion extension; `process.cwd()` is the fallback for dev and tests. The compiled binary sets it to its own directory before any server module loads: `import.meta.url` there is Bun's virtual `/$bunfs/`, which no other process (pi included) can read. A new file the server, daemon or pi reads at runtime also goes into `scripts/build-binary.ts`'s copy list.
- The binary needs `NODE_ENV` defined as `"production"` at build time (`scripts/build-binary.ts`); otherwise the server never writes the daemon's link. `npm run smoke -- --binary` catches that.
- `Bun.serve` turns on `SO_REUSEPORT` when `development` is false, so `startServer` passes `reusePort: false`; `startProduction` reports `EADDRINUSE` in one line.
- The daemon-owned watcher (`lib/hosts/workspace-watch.ts`) re-stats ~50 ms after every event to catch burst saves; main only routes its sequenced watch events.
- `bun:sqlite` `.get()` returns `null` for no row. `close()` keeps the file open while prepared statements live (Windows cannot replace it): stores close with `close(true)`.
- `readSttConfig` lives in server-only `lib/stt-jobs.ts`; the browser bundle must never import it.
- Browser code must not import `next/*`: use `lib/dynamic.tsx` and `lib/navigation.ts`.

### Environment variables
`TAU_PI_BIN` (pi binary), `TAU_NO_EXTENSION`, `TAU_PACKAGE_DIR`, `TAU_PORT`, `TAU_HOSTNAME`, `TAU_PASSWORD_HASH` /
`TAU_PASSWORD`, `TAU_TRUSTED_HEADER` / `TAU_TRUSTED_HEADER_SECRET` / `TAU_TRUSTED_HEADER_SHA256`, `TAU_SESSION_COOKIE`,
`TAU_SESSION_MAX_AGE_SECONDS`, `TAU_SECRET_ENV_VARS`, `TAU_DISABLE_AUTOUPDATE`, `TAU_DISCONNECT_DESTROY_MS`,
`TAU_STT_ENDPOINT` / `TAU_STT_KEY` / `TAU_STT_MODEL`, `TAU_PUBLIC_*` (inlined into the browser bundle). pi's own:
`PI_CODING_AGENT_DIR`. `lib/project-command-env.ts` strips tau's secrets, `PORT` and
`NODE_ENV` from every child environment.

### Tests (`npm test`, or `bun test --parallel <files>`)
- `--parallel` is required: Bun gives each file a fresh global/module registry. The transport singleton (`lib/event-stream.ts`) and each file's `SharedWorker`/fetch/DOM fakes would otherwise leak into the next file. Use `--parallel` even for a multi-file subset.
- `bunfig.toml` `[test] preload` runs `tests/isolate-tmp.mjs` in every test process: `TMPDIR`/`TEMP`/`TMP` point at a fresh per-process directory (mode 1777) removed in `afterAll`, so state a test writes after restoring its environment (a body past its timeout, a late timer) never lands in the machine's temp directory, where a running server would read it (e.g. `<tmp>/tau-self-update-<uid>`).
- DOM tests import `tests/setup-dom.mjs` first and then import Testing Library dynamically, so its queries bind to that document.
- A module that must see a fake builtin is imported with a fresh query (`?fresh=N`) after `mockBuiltin(t, name, overrides)` (`tests/mock-builtin.mjs`; Bun's `mock.restore()` does not undo `mock.module`, so the helper restores by hand).
- Tests that drive the hub call `flushLinkSamples()` before they restore `PI_CODING_AGENT_DIR`.

### Session lifecycle (`lib/rpc-manager.ts`)
- One wrapper per session id, keyed in a `globalThis` registry (a plain module-level Map does not survive `bun --hot`).
- Every link is host-owned (`hostOwnedLifecycle`): the daemon owns idle/disconnect cleanup and process-wide settings (`lib/hosts/channel-lifecycle.ts`). Wrappers report tab/command interest and protected preparation through transport capabilities (`setInterest`, `setPreparing`); disposal closes membership, while explicit delete/reload can kill. Reconciliation failure never kills a process another server uses.
- The server-side backstops run only for a transport without `hostOwnedLifecycle` (test fakes): concurrent `startRpcSession()` calls share one start promise; `IDLE_DESTROY_MS` (10 min) and `DISCONNECT_DESTROY_MS` (`TAU_DISCONNECT_DESTROY_MS`, 2 min, `0` disables) fire only once a session is genuinely abandoned (no `onEvent` listener, no run, no startup handshake, no unanswered `send()` or preparation). The last `onEvent` detach *starts* that window. Both are fed by `resetIdleTimer()`, the single activity choke point: a new call path must route activity through it.
- **Project trust.** The daemon starts pi with `--approve` (load the project's `.pi` and `.agents` resources) only when the cwd lies in a workspace registered on that host (`projectTrustArgs`, `local-host.ts`; `registeredProjectFor`, `lib/worktree.ts`: the project, a directory in it, or a linked worktree; pool clones are registered by `pool-starts.ts`). Elsewhere pi's rpc-mode rules decide: the nearest `trust.json` entry, then `defaultProjectTrust: "always"`, else untrusted. pi's flags that pick a session or its storage, leave RPC mode or end the process, change extension loading or override project trust (bare, short or `--flag=value`) are reserved and cannot be set in a project's launch configuration (`RESERVED_LAUNCH_ARGS`, `project-registry.ts`).
- **Session identity.** pi never moves a session to another file on its own. Branch/new/switch/fork drop every key the wrapper had; `startRpcSession` reuses a live wrapper reporting the requested session file instead of spawning a second `--resume` child.
- **Titles.** pi has no title generator. `POST /api/sessions/[id]/auto-name` answers the stored title, else one derived from the first user message, saved through the live process (`set_session_name`) when there is one, else as a `session_info` entry in the file; it never starts a process.

### Auto-resume after a restart
- **Hosts:** `lib/hosts/host-resume.ts` records unsettled sessions and their launch in `<agent dir>/tau/host-running.json`; the daemon resumes them once after its own restart (`RESUME_PROMPT`). A web-server restart just rejoins the running children.
- **Per web server** (`lib/session-resume.ts`, only for a transport without `hostOwnedLifecycle`): off by default (`autoResumeSessions`). When on, `notifyRunningChange()` keeps `<agent dir>/tau-interrupted-sessions-<pid>.json`; startup (`instrumentation.node.ts`) consumes lists whose pid is dead or that predate the last boot, restarts each session and sends `RESUME_PROMPT`. Each instance writes only its own pid's list. Sessions whose child died resume after the host's hello (`resumeOnHostLink`); a death is kept for `EXIT_GRACE_MS`, and `markShuttingDown` freezes the list during shutdown. Only ids are stored.
- Known limit: a terminal `pi --resume` of the same session while tau was down is not detected; both would write the file.

### Remote hosts (`lib/hosts/`, `app/api/hosts/`, `bin/tau-host.js`)
- **Host seam** (`lib/hosts/host.ts`). Every host, this machine included, is reached over its daemon's link: `getHost(id)` returns a `RemoteHost`. `getHost("local")` is this machine's own `tau host`. `localHost` (`local-host.ts`) is the daemon's side. `RpcProcess`, the wrapper, the event hub, notifications, the queue and `/btw` never see where pi runs. Session and project file reads are `host.sessionOps` (`session-ops.ts`, run in the daemon), addressed by session id, never by path: routes use `resolveSessionHostOr404` (`lib/api-utils.ts`). New route code must not open a session file on main. Workspace operations (files, index, shell output, watch, Git/worktrees, browsing, default cwd `~/tau-cwd-YYYYMMDD`, clone) are `Host.workspaceOps` (`lib/workspace-types.ts`, `workspace-ops.ts`) for every host; they never fall back to main. `SessionInfo.hostId` and `ManagedProject.hostId` carry the host; sidebar/project state keys on `hostProjectKey` (bare path here, `<hostId>:<path>` elsewhere).
- **Shared hosts** (`docs/specs/2026-11-06-multi-server-host-design.md`): one daemon links every server in `host.json` (the top-level pair is its primary link, `links` the others). `open` joins one session process; events fan out, command replies return only to their sender. The daemon owns lifecycle, streaming snapshots (`stream-snapshot.ts`) and first-answer dialog settlement (`shared-requests.ts`). Web callbacks (host tools) go to the last-active eligible server and are not blindly retried. `channels_changed` announces background runs; `sessions_changed` invalidates lists; `pi_version` reports pi found after a hello that said none (the daemon reads it again, 30 s doubling to 5 min); one link is the notification publisher (`notifier`). Cross-server fences live in the daemon: a history edit takes the `editLease` op before preflight, and a `peer_message_command` marker makes another server's identical echo ambiguous (`watchReplacement`). An open's preparation lease passes only to the command that asked for it (`withPendingCommand(run, true)`); a command timeout that recycles the child stops the shared process (`destroyAndWait(reason, true)`). Two daemons must never run competing `pi --resume` children on one agent dir.
- **Application link** (`/api/hosts/link`, `link-protocol.ts`, `hub.ts`, `daemon-link.ts`, `daemon-channels.ts`): one WebSocket per host per web server, dialled by the daemon. Text frames carry messages (hub → daemon one per frame; daemon → hub newline-separated batches flushed every `flushMs` (16 ms) or at one piece); binary frames carry large op results (before the `res` naming them) and upload bytes (hub → daemon, `up:<id>`). Every line except `hello`/`welcome`/`ack`/`ping`/`pong` has a per-direction `seq`; each side keeps unacked lines, resends after a reconnect and drops a `seq` it already applied. The daemon's first line of every frame is an `ack`; the hub answers every uplink frame with exactly one. Lines over `pieceBytes` (256 KiB) go as sequenced `part` messages (`PartJoiner`), results as binary frames of at most a piece; both sides queue per key (channel or request) in `LinkSender` and send round-robin. Each side sends queued units only while less than `unackedBytes` (512 KiB) is unacked (the daemon also waits for `bufferedAmount` under two pieces); control lines skip the window. The hub decodes a whole frame before applying any of it. `hello.ack === 0` means a fresh daemon. Each `hello.channels` entry carries `pending`: the raw stdout lines of that child's still-open `host_tool_call`s and blocking `ui_request`s (`pending-requests.ts`), or null past `pendingBytes`. Close codes (`LINK_CLOSE`): 1001 going away (shutdown), 1007 bad frame, 1008 bad first frame, 1009 too big, 4409 replaced, 4426 version; a revoked or unknown host's hello gets a plain close.
- **Protocol versions.** The application link is v1 (`MIN_LINK_PROTOCOL_VERSION` = `LINK_PROTOCOL_VERSION` = 1, literal one-liners that deploy scripts parse with `sed`). A released version changes only compatibly: an added optional field or a message type receivers skip is fine; a changed type or meaning, or a newly required field, needs a new version. Receivers skip unknown message types (acking their `seq`) and answer unknown ops 501 `unknown_op`. A hello outside the range gets 4426 with `{"serverVersion":N}`. Once versions are released, main keeps at least N-1, and the first released version is a floor `MIN_LINK_PROTOCOL_VERSION` never goes above. Upgrade order: web app first, then hosts.
- **Maintenance API v1** (`maintenance-protocol.ts`, `maintenance-hub.ts`, `daemon-maintenance.ts`, `/api/hosts/maintenance`): a separate request/reply WebSocket the daemon dials with the same bearer token, versioned apart (`MAINTENANCE_API_VERSION`) and kept stable so a host whose application protocol differs can still be inspected and updated. Ops: `status`, `listSessions`, `checkUpdates`, `updateSoftware`. Frames ≤ 1 MiB, 8 requests in flight, 30 s per request; a hello with another API version gets 4426 `{"apiVersion":N}`. Its hello reports `protocolVersion` (advisory), `tauVersion`, `piVersion`, platform and capabilities. Nothing it meets (no API on the server, another version, a refused token) stops the daemon or its pi children. Host updates use only this API (see "Updates").
- **Link samples** (`metric: "link"` in `<agent dir>/tau/transport-metrics.jsonl`, measurement only): each side samples every sequenced message once (size, session, `bytesAhead`) and records `ackMs` when it is acked; the daemon reports its `up` samples in sequenced `stats` messages (≤ `statsSamples`), batched per `statsFlushMs` (30 s). The hub drops malformed samples without failing the frame and caps `up` samples per host per window (excess as one `{dropped}` record). `bun scripts/link-hol-probe.ts` makes load; `scripts/transport-metrics.ts` prints the summary.
- **One socket per host per web server.** A new hello with the same token on the same server closes the previous socket 4409 (only that link ends). A frame belongs to the socket it arrived on: the hub ignores frames from a socket that is no longer the host's link. A revoked host is refused at the upgrade (401) and at the hello.
- **Transport down is not exited.** While the link is down the pi child keeps running. A wrapper whose host is not `isLinkUp(status)` is "transport down": no `process_exit`, idle/disconnect timers paused; frames carry `host_status`; sends answer 503 `{hostOffline: true, delivery}` (`"refused"`: nothing left, the composer keeps the draft; `"unknown"`: sent before the drop, the composer drops the draft so it is never sent twice). A child missing from `hello.channels` gets a synthesized `process_exit`. Use `isLinkUp` (client-safe) as the one link predicate; never compare `status === "online"` (a `pi-missing` host is linked).
- **A failed op never runs later.** An op that times out (504) or whose link drops (503, at once) is removed from the outbox (`failOp`), so a delete the user saw fail is never applied after a redial. The 30 s op deadline counts silence: each binary result frame restarts it. `destroyAndWait` returns once the host is offline (`untilHostDown`); the kill stays queued. A wrapper stays registered until its child really exits, so a retry awaits its `destroyPromise` instead of spawning a second `--resume` child; a reload waits for the old child the same way (`host_offline` until that exit or `lost`). Remote-only transport members (`onResync`, `lost`) are duck-typed: never `instanceof RemoteRpcTransport` (`bun --hot` may re-create the class).
- **Live-link recycle rule.** A prompt, history-edit or MCP command that times out normally recycles the child; on a remote host only if the host sent uplink traffic after dispatch (`lastUplinkAt`, `linkLostDuring`). A quiet or dropped link answers `host_offline` (503), queues no kill and leaves the run to `reconcileAfterGap`.
- **Orphans and adoption.** On `hello`, listed channels with no wrapper are adopted (`reattach`/`adopt`): servers `open` each, restore pending requests and the current streaming message, request state/subagents/side-question snapshots, then release held frames (`RpcProcess.release` skips requests the replay already delivered). Adopted wrappers feed replayed requests through `handleFrame` (`replaying`; agent tools are not re-run), so dialogs reappear and browser tool calls wait for the next tab (`hostToolsUnknown`, `parkHostTool`). Only when adoption is impossible is a child killed (escalating to force after 5 s). A cold spawn awaits `orphanExit(hostId, sessionId)` first; the wait rejects 503 when the link drops. A daemon buffer overflow (`channelBufferBytes`, 32 MiB per channel) drops the backlog and sends `resync {ch}`; main reruns the `get_state` reconcile.
- **Proxy exclusion.** `proxy.ts` `UNGATED` lets through exactly `/api/hosts/link`, `/api/hosts/maintenance`, `/api/hosts/cluster-config/manifest` and `/api/hosts/cluster-config/file/<64 hex>` (plus static assets, icons and `sw.js`). The daemon has no cookie; each of these checks `Authorization: Bearer <host token>` itself (the link before the upgrade: 401 unknown token, 503 unreadable `hosts.json` or frozen server; the cluster routes through `admitClusterMember`, again after the build). `/api/hosts` and `/api/hosts/[id]/*` (an id of `cluster-config` included) stay gated. A reverse proxy passes the ungated paths without its own authentication and without redirects.
- **Remote paths never reach `allowFileRoot`** or any other main-side filesystem check. `startNewRpcSession` calls `allowFileRoot` and the local list invalidation only for the local host; remote cwd validation is the host's `validateCwd`. Daemon input is untrusted: blob hashes must match `^[0-9a-f]{64}$`, results are shape-checked (`hub.ts`, `workspace-results.ts`), and `sessionFileExists`/`spawn` accept only paths under the daemon's sessions directory. A remote session export is always an attachment.
- **Daemon-loaded modules must not import `@/` or use Bun APIs.** `bin/tau-host.js` loads `lib/hosts/host-cli.ts` through plain `jiti` on Node (no `@/` alias, no `Bun` global); that covers everything the daemon pulls in (`daemon*.ts`, `link-protocol.ts`, `maintenance-protocol.ts`, `local-host.ts`, `session-ops.ts`, `workspace-*.ts`, `preflight.ts`, the `lib/pi/*` they import). Use relative imports.
- **Registry.** `<agent dir>/tau/hosts.json` (0600, atomic) stores only `sha256(token)`; the token is shown once. Mutations use the strict reader and throw `HostRegistryUnreadableError` (503) instead of rewriting a file they could not parse. Revoke deletes the record first, then closes the link (the daemon stops its children). A missing `hosts.json` (an agent-dir mismatch) answers 401 to every daemon, and a daemon told its token is unknown stops all its pi children: check `PI_CODING_AGENT_DIR` before starting main.
- **Agent tools.** Calls carry the caller's host (`sourceHostId`); `new_session`'s `host` defaults to it. A host with `allowAgentStart` off asks a server-owned `confirm` (`confirmFromServer`). Local callers never ask for this machine; a remote caller asks before any other host unless that host allows agent starts, and always before this machine, for `new_session` and `send_to_session`.
- **Message origin** (`docs/specs/2026-11-14-message-origin-design.md`). Messages from `send_to_session`, a `new_session` first prompt or the GitHub watcher stay native user messages but carry server-authored `origin`. The extension journals it with the message's `client-message-entry` (`/tau_meta name`); the reader joins it only on the active branch, and the outbox stores it beside held entries. Browser/HTTP commands cannot supply `origin` (`origin_not_allowed`); readers drop malformed or over-4096-byte metadata. The chat renders trusted origins as source cards (`OriginMessageView`).
- **Transcript search is per host.** `/api/sessions/search` asks each daemon to score its own conversations and streams the score maps in sidebar host order. An offline or failing daemon contributes no transcript scores; title search still works.

#### Cluster (`lib/hosts/cluster.ts`, `pools.ts`, `pool-starts.ts`; `docs/specs/2026-11-11-cluster-membership-design.md`)
- The cluster is `pools[0]` of `<agent dir>/tau/pools.json`; `local` is its master, added on creation or on the next join. The rest of `pools.json` is ignored by the interface. An unreadable `pools.json` refuses a start (503 `pool_storage_unavailable`).
- **No credential sharing.** Every host, members included, uses its own pi logins (`auth.json` is never mirrored). Placement (`pool-starts.ts`) skips a member that has no login for the requested provider (`canAuthenticate`, from the host's `auth` op) and a member not on the master's current configuration (`isHostConfigCurrent`); `startPooledSession` says "still receiving the cluster's configuration" when that is why.
- **Join keeps what the host showed.** The host's Git projects bind to cluster projects by repository (`gitOrigins`); a created cluster project takes the host project's name, else its folder name, and its alias; binding a visible checkout un-hides a hidden cluster project. `POST /api/projects` pool registration matches by `repositoryKey` and keeps the stored origin. A join of a host holding another server's configuration is 409 `host_in_other_cluster`; a host joins once it is online (`clusterJoinBlock`).
- **Only grouping passes `pools` to `projectTargetId`.** Selection, expand keys, reorder, pin and drag use the project's own target.
- For a cluster session on another member (`isClusterTarget`), the MCP, Skills and Plugins panels use no cwd and no session (the user-level routes).

#### Cluster configuration (`cluster-config.ts`, `cluster-config-server.ts`, `daemon-cluster-config.ts`; `docs/specs/2026-11-11-cluster-configuration-design.md`)
A member runs pi on the master's configuration; its daemon applies it, never pi.
- **Mirrored** (`MIRRORED`): from the agent dir `settings.json`, `models.json`, `mcp.json`, every context-file candidate (`AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`), `SYSTEM.md`, `APPEND_SYSTEM.md`, and the `skills`, `prompts`, `themes`, `extensions` directories; from home `~/.agents/skills`. Never credentials (`auth.json`, `mcp-auth.json`), sessions or caches (`npm/`, `git/`, `bin/`), nor `.pi/` in a repository. pi packages travel as `settings.json` `packages`, which pi installs at startup; there is no separate plugin step.
- **`settings.json`** is mirrored without the `LOCAL_SETTINGS` key paths (local paths and programs, installation identity, terminal: `shellPath`, `npmCommand`, `sessionDir`, `httpProxy`, `extensions`, `skills`, `deviceId`, `terminal`, ...); the member merges its own values back (`mergeLocalSettings`). One constant serves both sides.
- **Master.** `buildManifest` lists the files with hashes, the agent environment variables and a `version` (sha256 over all of it). Limits (`CONFIG_LIMITS`): 5 MiB per file, 50 MiB per bundle, 5 MiB manifest; a configuration over one is not served (`ClusterConfigError`, naming a path and never content; Settings shows it as `masterConfigError`). `currentClusterConfig` rebuilds only when its fingerprint (a stat walk, skipping `.git`/`node_modules`) changes; a read error makes the fingerprint unique so the error is reported. `syncClusterConfig` (`hub.ts`) runs at start, every 30 s and on a new version: `clusterConfig apply` to each online member that is not current, `restore` to a host outside the cluster that still holds this server's configuration; never while one of that link's ops is unanswered. Join sends `apply` after it saves `pools.json`, leave `restore`; neither awaits between reading and saving the pools.
- **Launch.** The hub sets `open.launch.configVersion` (64 hex) for a member's process start (not a join), after re-reading `pools.json`. The daemon strips `configVersion`/`configServer` from every wire launch and sets them only for the opening link (`forStart`); a launch with a version applies it first (`ensure`) or is refused 409 `cluster_config_failed`. The version is never written to the resume manifest.
- **Daemon.** Per version: manifest, then each missing file by hash (`<agent dir>/tau/cluster-config/objects/`, verified), then one transaction: stage, move the member's own entries aside (first apply: `own-config/` with its `settings.json`, `agent-env.json`, `server.json`; later: `trash/`), move the staged ones in, write the agent environment and `state.json`. Any failure puts everything back. Renames move links as links and cannot cross filesystems (`EXDEV` names both directories). Requests to the master must finish within 30 s (`clusterConfigTimings.fetchMs`). Applies and restores run one at a time.
- **Ownership.** `own-config/server.json` records the one server whose configuration the host holds. Another server's apply is refused while that one is still in `host.json`; one no longer linked is taken over. Only the holder's `restore` puts the member's own configuration back; a start sent before its restore is refused after it. A link that ends revoked while its server holds the configuration awaits `restore` before the daemon stops.
- **Reports.** `config_state { state, owned }` is an unsequenced daemon report (like `capacity`): at link up, on change and after each `host.json` reload. `ConfigState` is `{ version, files, error, missingCommands }`; Settings shows current, updating, failed, held by another server, and the MCP commands missing on the member.

#### Local daemon (`docs/specs/2026-10-29-local-daemon-design.md`)
- **Independent lifetime.** Installers install web and host services together; web restarts leave the daemon's sessions running. Production also starts a missing local host itself (`local-daemon-start.ts`) after preparing its link and probing its private control endpoint (`host-control.ts`: an owned 0600 socket, or a random named pipe with a per-start token on Windows; `tau host status|drain|resume`). An unknown or unsafe existing endpoint is an error, not permission to start another host. `local-daemon-supervisor.ts` knows the installed services (`tau-host.service`, launchd `dev.ompweb.tau-host`, task `tau-host`).
- **Local link bootstrap** (`local-bootstrap.ts`): `ensureLocalHostLink()` upserts this server's `{url, token}` in `host.json` under the same lock as token selection, preserving the primary pair and other links (0600). The daemon's directory watch reconciles added/removed links without a restart. `tau host login [--add] --url <url>` (token from stdin) and `tau host logout --url <url>` manage links; a remote primary is never replaced by local bootstrap.
- **Dev mode does not take the daemon.** With `NODE_ENV=development` `ensureLocalHostLink` is skipped, so the daemon stays with production and the dev server shows "This machine" offline (`daemonManaged: false` hides the install banner).
- **`local` is a registry record like any host**, except that it is listed first, `PATCH` takes `label` only, and it cannot be revoked; an empty label resets it to "This machine" (`customLocalLabel`). `getHost("local")` works without the record.
- **Shutdown freezes the links and never kills daemon children.** `cleanup` runs `markShuttingDown()` and `freezeHostLinks()`: sockets close 1001, and a link then neither sends nor applies anything; new upgrades get 503. A real SIGTERM exits in the same tick, so daemons usually see 1006 and redial; they keep their output unacked for the next server.
- **Failed-start guidance** (`LocalDaemonBanner.tsx`): if no daemon links within 90 s, the banner and Settings → Hosts show start/install guidance.
- `tau preflight` (`preflight.ts`) starts pi the way a host starts one for a new session (`--no-session`, scratch cwd, `PREFLIGHT_MARKER`) and waits for `get_state`; updaters run it on a candidate release and grep its `preflight ok:` line.

### Browser compatibility
Client code (`components/`, `hooks/`, the worker) must not call `AbortSignal.timeout`, `AbortSignal.any` or `Promise.withResolvers`: older mobile browsers throw and the whole tree shows the error screen. Use `AbortController` + timers and executor-style promises. Server code may use them.

### Browser storage and events
Browser keys use `tau-` / `tau:` (`tau-theme`, the `tau-theme-color` cookie, `tau-draft-*`, `tau:expand-thinking`, `tau:submit-during-run`, ...); window events are `tau-*` / `tau:*` (`tau-open-session`, `tau:connection-diagnostics`, ...); IndexedDB is `tau-outbox`.

### Editing and branching — don't confuse them
- **Fork** ("Fork a new session from this point", user and assistant messages; only while idle: `!sessionBusy && !isNew`): pi's `fork` RPC writes a new `.jsonl` with the history before a user entry and switches the live process to it; the sidebar shows it as a child via `parentSession`. `lib/chat-fork.ts` maps rows: a user prompt forks at itself and its returned `text` prefills the composer (text only); an assistant reply forks at the next user prompt so the reply is kept; the newest reply falls back to its own prompt with the prefill. Rows that would fork before the very first prompt offer no fork. The button only opens a `ConfirmDialog`.
- **Edit** (`edit_message`, user-message button, confirm first): moves the live conversation's leaf to before that user entry through `/tau_edit` (`navigateTree(entryId, { summarize: false })`); the old branch stays in the file. The server never imports pi's SDK or rewrites the JSONL.
  - Requires authoritative `get_state.isSettled === true` and no pending work (`session_edit_unsupported` without settlement reporting, `session_busy` otherwise). Preserve run/edit fencing, including rename and title fallbacks; do not report success after an observed edit-time persistence error notice.
  - `SessionEditResult` is `{ sessionId, cancelled, leafId }`; the wrapper checks it against a fresh `get_state` and refuses any other id or file (`session_changed`: pi never moves a session to a new id). Reload the history before the text prefill.
  - `/tau_edit` arrives as a `prompt`, so an installed input hook must pass it through unchanged; this is an explicit compatibility boundary.
  - Prefill only the selected message's text, never its images. Preserve drafts, newer typing and attachments through pending edits, cancellation, errors and navigation. `submissionBlocked` keeps asynchronous dictation from submitting or clearing the composer. `session_history_changed` carries the leaf marker; the initiating tab deduplicates its own echo. Editing does not undo tool side effects.
  - Draft text survives reload via sessionStorage; attachment payloads stay in memory.
  - Event connections own their readiness waits: replacement and unmount settle the old wait as closed and close its observer; stale continuations must not attach streams or authorize operations. A new chat's first prompt is the exception: when its chat unmounts while pi spawns, `handleSend` still sends it and returns `accepted`. Existing sessions' messages go through the outbox.
  - `ChatInput.onSend` returns `Promise<PromptSubmissionResult>` (`accepted` / `rejected` / `superseded`). With `outbox` the composer clears only once the message is stored in the browser's outbox and only if it still holds what was sent. For a new chat only rejection restores the draft (`recoverDraft`; the composer owns recovery); superseded failures never reinsert a processed turn.
- **In-session branch** (Continue / BranchNavigator): a read-only historical view of the entry tree through `/api/sessions/[id]/context?leafId=` (`handleLeafChange`); it does not change the live agent. Never implement Edit with it.

### ToolCall field normalization
Session files store toolCall blocks as `{type:"toolCall", id, name, arguments}`; `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` (`lib/normalize.ts`) converts, in `session-reader.ts` and in stream handling.

### Live tool execution (`tool_execution_start/update/end`)
pi announces a tool when it starts, streams its partial result while it runs, and commits the `toolResult` message at the end. The UI must not wait for the commit:
- `useAgentSession` keeps `liveToolResults` by `toolCallId` (seeded on `_start` with `partial: true`, replaced on each `_update`, which carries the whole accumulated partial result, released on `_end`/the committed result). Committed results always win (`ChatWindow` merges them).
- `ToolCallBlock` renders a `partial` result as running ("Running tool…" while nothing is printed), and opens the row while it runs when "Keep tool calls collapsed" is off. `AppShell` must pass `toolCallsDefaultCollapsed`, `hideToolActivity` and the display options into `ChatWindow`, or the settings are inert.
- `CommittedTranscript` folds the running turn into **Process details** rows while "Hide tool activity while working" is on (default). `planTurnSegments` (`lib/chat-transcript-plan.ts`) also honors `showThinking` ("Expand thinking blocks by default"), `showToolCalls` (`tau:show-tool-calls-unfolded`) and `neverFold` (`tau:never-fold-activity`: every turn as standalone message rows; overrides the hide setting).
- `tool_execution_update` is coalesced per tool call at display rate (`lib/message-update-coalescer.ts`). `message_end` drops the pending `message_update` but never buffered tool updates.
- Live entries are cleared on `agent_start`, terminal `agent_end` and prompt failure.

### Reasoning display
`ThinkingBlock` seeds `expanded` from `expandThinkingByDefault` (`tau:expand-thinking`, off by default), an initial value only; it covers streaming blocks too, so no state flips mid-stream. Auto-expanded historical blocks are deferred: a mount effect loads them through `/api/sessions/[id]/entries/[entryId]/thinking`, cached per (session, entry, block). While on, thinking never folds into Process details.

### Tool-result images (`lib/media-cache.ts`, `/api/media/[hash]`)
Tool-result images never reach the browser as base64: history (`deferMedia`) and live frames (`AgentSessionWrapper.emit`, which also feeds the replay snapshot) replace each with `{type:"image", mimeType, url:"/api/media/<sha256>"}`; user-message images stay inline. pi stores images inline in the session file, so they are hashed and copied to `<agent dir>/tau/media/`. A daily sweep deletes copies older than 30 days. `?thumb=1` serves a 480px WebP (`Bun.Image`, EXIF-oriented, cached). Only PNG/JPEG/GIF/WebP by magic bytes.

### Streaming message updates
pi's wire `message_update` is delta-only (pi `docs/json.md`): `usage` and `assistantMessageEvent`, never the message, an id or a `partial`.
- The daemon (`piStreamFrame`, `daemon-channels.ts`) gives each assistant message a `messageId` at `message_start` (and on `message_end`), and each update that id, `message: { role }` and, on `text_start`/`thinking_start`/`toolcall_start`, the empty block they open. Everything after it reads that shape.
- `lib/message-delta.ts` is the one reducer, shared by server and browser: `*_start` carries the opened block, `*_delta` appends at `contentIndex`, `*_end` carries the final block. `toolcall_delta` text accumulates in `partialJson`; arguments are parsed only for display and snapshots (`withStreamedArguments`). It returns null for anything it cannot place; nobody renders a guess. `message_end` is authoritative.
- The wrapper keeps each open assistant message by `messageId`. `getStreamSnapshot()` (HTTP catch-up) carries it with `streamingMessageId`; `onEvent` replays it as one whole `message_update` to a tab that attaches mid-message. With no base (frames lost on the link; `reconcileAfterGap` drops every base) a delta is not forwarded and the wrapper asks the link for a resync, once per message or run.
- Backpressure (`event-stream-hub.ts`): a behind sink queues `message_update`s; consecutive deltas of one block concatenate, a whole message replaces its queued updates, nothing is dropped or reordered. Merged frames keep the latest sequence and carry `web.first`. Deltas of different blocks never merge past each other.
- Browser (`message-update-coalescer.ts`): applies each delta on arrival and dispatches whole messages at display rate. A delta with no base is held (≤ 1000) and triggers a catch-up; the HTTP snapshot (`seed`) re-bases the coalescer. A snapshot at S already holds delta S (`useAgentSession-sync.ts`); a merged frame with `web.first <= S < sequence` waits for the next snapshot. Streamed tool arguments re-parse only after 2 KB more JSON or 100 ms.

### Queue (pi-owned)
- The queue panel renders pi's queue only: `get_state.queuedMessages` (filled from the last `queue_update`) on load/reconcile/stream open and live `queue_update` frames, with client ids and origins from the extension's `tau_queue` names when they line up. Never track chips client-side; the outbox's held bubbles are the only exception. One sequence (`queueSeqRef`) orders every source.
- pi takes its queue back only whole: `clear_queue` answers `{ steering: string[], followUp: string[] }` (texts, never images). Chip edits and deletes use it (`clearQueuedMessages`, one at a time per session) and the chips leave with pi's next snapshot; the wrapper then tells the extension (`/tau_meta clear`), which journals the withdrawn ids as resolved.
- Stop (`handleAbort`) coalesces overlapping clicks and sends `abort_and_restore_queue`, which the wrapper runs as the TUI's Esc: `clear_queue`, then `abort` (pi would otherwise run a queued message as soon as the abort lands). The withdrawn texts return as `{ steering, followUp }` of `{ text }` and go to the draft (`recoverDraft`), even when the abort fails. A failed request is retried once while the captured run is current; otherwise the hook warns (`queueRestoreUncertain`).
- Submitting during a run defaults to **Queue follow-up** (`tau:submit-during-run`).
- pi takes a prompt while tau's `!!` shell command (`bashRunning`) runs, and a `follow_up` queued with no turn running waits for the next run: the outbox decides prompt versus follow-up with `isRunning(true)`, which leaves the shell command out.
- A `!cmd` during a run runs at once beside the turn. pi holds its result back until a later prompt; the wrapper marks the reply `deferred` (read in `sendCommand`'s `onReply`). The hook shows it from `heldBash` until the transcript has a run of that command stamped after the newest stamp the tab had seen (`newestStampRef`; never compare counts); each recorded run settles one entry (`settledRunsRef`), for good. Stop stops a running turn first; `abort_bash` only when no turn runs.

### Message outbox (`lib/message-outbox.ts`, `lib/event-stream-worker.ts`, `docs/specs/2026-11-04-message-outbox-design.md`)
- **Every message to an existing session is held until acceptance is confirmed**: prompt, follow-up or steer (slash commands too; `!cmd` and `/btw` keep their own paths). Send ends once browser storage commits. Unconfirmed outcomes stay visible across reconnects, restarts and outages; uncertain host delivery is never resent. New chats keep the `ensureNewSession` + prompt path.
- **Browser leg.** `addToOutbox` hands the entry to the worker, which commits it to IndexedDB (`tau-outbox`) and only then answers, so the composer clears only then; a missing IndexedDB or failed transaction keeps the draft. The worker POSTs `outbox_add` to `/api/agent/[id]`, one entry per session at a time, oldest first; 401/408/429/5xx/network retry with backoff (1 s → 30 s, at once on a wake), other 4xx fail it. The browser copy is deleted only after a matching successful outbox receipt, once the IndexedDB transaction completes. Enqueue order and unique ids are allocated atomically. An entry unsent seven days after `createdAt` fails (server ids live eight days), as does an unscoped one; every sender persists that failure before moving on. Pagehide sends each session's head only (64 KiB total). Background Sync registers only after the active service worker proves outbox capability (`tau-outbox-capability`). A transient initial IndexedDB read failure must not latch the worker unusable.
- **Idempotent by id.** `outbox_add`/`outbox_remove` run in `runAgentCommand` before any wrapper spawn; a repeat answers the stored entry.
- **Scope follows the installation, not the cookie.** `outboxScope` (state route or `outbox_scope`) is a nonsecret installation/auth fingerprint, cached for offline enqueue and persisted unchanged on each entry; a replaced installation or credentials refuse it with `outbox_scope_changed`. Without a cached scope a first offline send keeps its draft.
- **Server leg.** SQLite (`<agent dir>/tau/outbox.db`) and a per-conversation FIFO dispatcher (aliases share the claim). Acceptance is bounded per alias (16 MiB) and globally (256 MiB / 1,000 active rows); overflow is retryable 429 while the browser keeps its copy. Never trim accepted rows. Startup recovery fails a same-PID `delivering` row unless this process holds its claim.
  - A steer is not held while an ask is open: pi queues it until the turn ends and tau's ask tool keeps waiting.
  - Host offline → `waiting_host`; uncertain replies or child exits while delivering → `failed` with `mayHaveBeenSent`, never resent. Anything that stops an entry before its native write leaves it unsent (a gone child retries after `RETRY_MS`). The boundary is `nativeWriteStarted(command)`, set by whichever wrapper's `sendNativeMessageCommand` writes that command object (test fakes record theirs in `__tauNativeWrites`).
  - An `outbox_add` for an archived session is held until restore (the restore route pumps it); only a session neither listed nor archived is 404.
  - Host tool registrations apply in `sendCommand`'s `onReply` (success only), so a call in the same batch as the reply is routed. Only the submitted command's own reply proves rejection.
  - The session carries `outbox_update {entries, settledIds}` on subscribe and every change, and opens without a wrapper while held entries exist; `GET /api/sessions/[id]/state` carries `outbox`, `outboxSettledIds` and `outboxScope` on every answer, an offline host's error included.
  - **Upload proofs.** Upload completion receipts persist privately before the completion ACK and carry an upload-specific `proof`; browser-held entries keep it as `uploadProofs`. Authority is revalidated inside the same immediate transaction as the outbox insert. Proofs never reach the daemon, pi, public snapshots or logs; a completion replay never substitutes bytes.
  - **Message-proof taint.** The server captures `previousEntryIds` before dispatch and publishes it only on the active delivering entry. Replacement inference requires unambiguous admission. The taint lifts only through `clearMessageProofTaintIfSettled`: a `get_state` issued after every message command was answered, reporting settlement with no active/queued/background work, no dialog, history mutation or unrelated pending command, and stable admission generation and identity.
- **Held bubbles** (`HeldMessageView`, after the live turn: server-held entries in arrival order, then this browser's first-leg entries): the hook merges the worker's entries with the server's snapshot by id; `{stored}` bridges until the server lists or settles the id; seen/settled ids stop late ACKs from resurrecting entries. States: Sending, Waiting to send / Waiting for <host> (Delete), Delivering (locked), Not sent (Retry, Delete). Retry (`retryHeldMessage`) holds a new entry with the same content and `replaces: <failed id>`; the server retires the failed original in the transaction that stores the copy, and the worker deletes the browser's row in the same commit. Retry holds no second copy while one naming the id waits; a `mayHaveBeenSent` entry asks first. Delete (`deleteHeldMessage`) awaits the IndexedDB delete; a server entry sends `outbox_remove` (409 `outbox_dispatched` once delivering).
- **Run state comes from pi's frames**, never from Send. A prompt's bubble leaves when the server sees pi's reply and echo; the hook shows pi's echoed user message (`echoedUserMessage`) until the transcript has its saved copy. A follow-up or steer becomes pi's queue chip. Streams opened for held messages (`connectEvents(sid, "connected")`) talk to pi only after `connected`.

### GitHub agent tools (`lib/github/`, `docs/specs/2026-11-13-github-watch-tool-design.md`)
- **Server login only.** Every call uses the web server's `gh` login (`createChildProcessEnvironment`; `GH_TOKEN`/`GITHUB_TOKEN` removed, API pinned to `github.com`). tau never reads, stores or forwards a GitHub token. Missing or logged-out `gh` returns a tool error naming the step.
- **Tools.** `watch_github`, `unwatch_github`, `github_read`, `github_comment`, `github_resolve_thread`, and the Actions tools `github_workflow_list`, `github_workflow_read`, `github_run_list` (reads), `github_workflow_dispatch`, `github_run_cancel`, `github_run_rerun` (writes, each governed by `githubActionsPermissions`, `ask` by default; reserved before sending in `action-receipts.ts`, never replayed on an unknown outcome).
- **Updates are metadata only.** A watch update is a `prompt`-mode outbox entry naming `OWNER/REPO#N` and the URL, with metadata (logins, ids, URLs, review states, counts, thread line numbers, CI counts by conclusion). Check names and file paths are left out (a fork's author names them); `capName` bounds names in confirms. Pending reviews are left out. Only `github_read` returns GitHub prose.
- **Crash idempotency.** `claimPending` checks the watch's registration, cursor, pending state and posting fences before persisting deterministic batches; a restart replays the same batch id, which the outbox collapses. A 404 ends the session's watches.
- **Own posts.** `recordPosted` stores exact comment/review identities (with `review:<databaseId>` aliases); snapshots suppress only those. A crash after GitHub accepted a post but before it was recorded can still produce one update.
- **Confirmations.** Local reads never ask. A remote session's read, watch, unwatch, comment and resolve ask once per session and repository (`hasReadGrant`/`grantRead`) unless that host's `allowAgentStart` is on. Comment and resolve ask every time unless `githubWritesUnasked` is on. `host_tool_cancel` aborts the call's signal; a write checks it right before posting.
- **Replay after a restart.** Only `GITHUB_REPLAY_SAFE_TOOLS` (watch, unwatch, read, the Actions reads) and `list_sessions` run again (`new_session` too while Agent tools is enabled); writes answer the unknown-outcome error telling the agent to check first.
- **Limits.** 20 watches per session; a 60 s cycle (1.5 s per item past 40); about 1 GraphQL point per snapshot; below 200 points (`BUDGET_FLOOR`) polling waits for the reset. CI is reported once per head. With Agent tools off, polling pauses and resumes from the stored cursors.

### Live event stream: one connection per browser (`/api/events`)
- Browsers cap HTTP/1.1 at **6 connections per host across all tabs**, and an SSE response pins one. **Never add a new `EventSource`**: add a channel.
- `lib/event-stream-worker.ts` (SharedWorker; dedicated Worker where SharedWorker is missing) holds the browser's one `/api/events` EventSource and multiplexes every tab's subscriptions: frames arrive as `event: <subId>`, control frames as `event: mux` (`hello`/`open`/`end`); subscriptions are attached with `POST /api/events`. Tabs POST their agent commands and uploads themselves. `buildEventStreamWorker` bundles it into `dist/event-stream-worker.js`, whose URL carries the content hash.
- Tabs use `openEventStream(channel)` (`lib/event-stream.ts`) with EventSource semantics: `onerror` + CONNECTING = reconnecting, CLOSED = fatal (e.g. 409 for a wrapper-less session). Dead tabs are detected with a lifetime Web Lock.
- Channels (`event-stream-hub.ts`): `running` (badges + list hints), `notifications` (one tab's, by `clientId`), `hosts` (the `GET /api/hosts` body), `host-tools` (cross-session `open_url`/`notify`/`open_file`), `session` (observer-only, never spawns pi; merges `message_update`s under backpressure), `file` (viewer watch, same allow-list as `/api/files`). A failing frame ends only its own subscription. Split channels by consumer, lifetime, key and access check; `notifications` and `host-tools` are subscribed from `AppShell`.
- **Tool snapshots** (`event-stream-hub.ts`, session channel): pi sends the whole accumulated output on every `tool_execution_update`, so the newest snapshot per `toolCallId` is held outside the ordered message queue and written at most once per `TOOL_UPDATE_FRAME_MIN_INTERVAL_MS` of that tool. Any other session frame is a boundary that releases every held snapshot ahead of itself in emission order, so nothing is dropped or reordered within a domain; across domains an older sequence may arrive later, which the browser's separate floors (`hooks/useAgentSession-sync.ts`) allow. A written snapshot is stamped with its write time.
- **Native-client handshake and keep-alive.** `GET /api/app-info` (behind the `/api` gate, `no-store`) answers `{ name, version, api: 1, capabilities }`: package identity and which server-side features exist, never a credential or setting. A capability is added only with its implementation; today it carries `heartbeatParam`. `GET /api/events?heartbeat=<seconds>` sets that connection's keep-alive comment frame: an integer in 15..110, anything else the 30 s default (not clamped). A value above the reverse proxy's read timeout (nginx: 60 s) drops an idle stream before its first keep-alive.
- **Metrics.** Tabs and the worker record `action`, `event`, `reconnect`, `hang` and `dropped` samples; the worker POSTs them to `/api/transport-metrics` every 30 s or 200 samples. One worker-wide clock (lowest RTT of recent probes) times them.
- **Connection tab** (right panel, while "Show connection diagnostics" is on, `tau:connection-diagnostics`): polls the worker (`diag`) once a second; status, last reconnect and per-transport stats (`lib/transport-stats.ts`) over the last 30 min. Command rows include confirmed replies only; app ↔ pi rows skip commands the web app answers itself (`NO_SPAWN_REPLIES` and friends).
- **Worker rules.** No `AbortSignal.timeout`/`any` or `Promise.withResolvers` (a test checks the bundle). Every global it uses must be injectable into the `vm` context of `lib/event-stream-worker.test.mjs`. Ids use `Math.random().toString(36).slice(2, 12) + Date.now().toString(36)` (insecure LAN origins lack `crypto.randomUUID`).

### Running state and reconciliation
- The sidebar subscribes to `running` (`subscribeRunningSessions()`), so badges update without polling.
- An open chat subscribes too: when its session appears there without a `session` stream (a run started elsewhere), it reads `GET /api/agent/[id]` and attaches as on load (`attachLiveRun`). The lookup waits for the chat's own work (mount load, a connecting stream, a local send, `!` command, Edit or compaction) and rechecks after it (`runningRecheckRef`); a failed lookup retries after 1, 2 and 4 s.
- Compaction state has one owner at a time: a manual compaction holds it until its command settles (`localCompactionsRef`); snapshots apply only if no compaction started or ended since they were requested (`compactionGenRef`).
- While a run is active `useAgentSession` polls `GET /api/agent/[id]` and reconciles on `visibilitychange`/`online`, so a missed `agent_end` cannot leave the chat running. A monotonic prompt run id keeps late frames or polls from resurrecting old streaming bubbles.

### Composer panels (`components/ComposerPanels.tsx`)
The todo plan (`TodoList`) and subagent roster sit pinned above the input, each collapsible (collapsed by default; headers show live progress). Non-running chips nest under `Completed (N)`. Subagent chips carry live state from `subagent_lifecycle`/`subagent_progress`; a click opens the transcript dialog. The `/btw` panel comes first and is keyed by record id: each new topic starts expanded.

### Side questions (`/btw`; `lib/btw.ts`, `hooks/useBtw.ts`, `components/BtwPanel.tsx`)
- `btw` / `btw_cancel` / `get_btw_history` are agent commands the wrapper runs through `/tau_btw`; the extension answers from the conversation with the session's model (never added to it), streams `btw_delta` and `btw_record` frames and persists records as `tau_btw` custom entries.
- `/btw <question>` and `/btw` are client builtins (`handleBuiltinSlashCommand`), routed before attachments are folded in: never a prompt, never queued, refused with a toast while attachments are attached. Asking starts the wrapper (`get_state`) and attaches SSE first.
- The response, history snapshots and frames race: merge only through `lib/btw.ts`. A record running before a history read and missing from it becomes `interrupted`.
- `btw_*` frames skip the message-update coalescer, are batched in `useBtw` with `scheduleAtDisplayRate`, and are routed **before** `catchUp.observe(event)`, whose `"epoch"` branch would reset the transcript.
- `get_btw_history` and `btw_cancel` never spawn pi (`NO_SPAWN_REPLIES`: empty history, `cancelled:false`). A refused explicit ask or history read shows a toast (`toastBtwError`); background reads stay silent.

### Subagents (`lib/pi/subagent-bridge.ts`, `lib/subagent-types.ts`, `lib/subagent-history.ts`)
- pi-subagents reports foreground runs as progress on its `subagent` tool call (`details.progress[]`) and background runs on its `subagent-async` widget; `SubagentBridge` turns both into roster frames and answers `get_subagents`. `subagent-types.ts` parses progress defensively (current tool, tokens, cost, model, retry, detached flag).
- **Roster hydration:** `get_subagents` snapshots rehydrate the roster after reconnect (`refreshSubagentRoster`); history from disk fills in finished runs (`extractSubagentHistory`, result fields win over mid-run snapshots).
- **Transcripts:** the host-backed route pages the subagent's session file byte-wise without a live process; `?mode=completion` reads its final output (bounded tail). Ids match `SUBAGENT_ID_RE` (`[A-Za-z0-9_-]+` segments joined by `.`, ≤ 100 characters), validated before any path join.
- **`agent://` links** (`lib/agent-links.ts`): `MarkdownBody` linkifies handles and opens them through `AgentLinkContext` (`agentLinkTarget`); without a provider they render as text; `agent://all` is never linked. Every `ReactMarkdown` host must drop rejected hrefs (`defaultUrlTransform(url) || undefined`).
- **In-message task summary** (`MessageView-task-panel.tsx`): the reader keeps a size-bounded telemetry subset of task results (`keepTaskToolResultDetails`: no output/stderr, text ≤ 240 characters).

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktrees back to the main repo `projectRoot`; sessions in any worktree group under one project. Sessions whose cwd is a removed worktree fold back into the main project.
- `/api/worktrees` runs on the owning daemon; only that host's list cache is invalidated on main. New worktrees go under `<repoRoot>-worktrees/<sanitized-branch>`; a dirty removal returns 409 `{ dirty: true }` so the UI can ask before `force`.
- The **Worktrees** tab (`WorktreesPanel.tsx`) switches, creates and removes; the new-session worktree `<select>` only switches. `SessionSidebar` owns the cache and emits a `WorktreeContext`. Switching moves where a new session starts, not the open session. Explorer, Git and every file tab keep their owning host (and a tab its cwd and session).

### Managed projects sidebar (`lib/project-registry.ts`, `/api/projects`)
- The sidebar lists registered projects (`<agent dir>/projects.json`, atomic) plus session-discovered ones, minus hidden entries. Removing only hides (re-adding restores); hidden entries suppress rediscovery. Registry paths are canonical `projectRoot`s (`resolveProject`).
- `GET /api/projects` re-authorizes registered roots with `allowFileRoot()` (the allowlist does not survive restarts).
- Sort "None" orders by manual `sortOrder`, then most-recently-added, then path, so rows never jump. The sort button (`tau:project-sort`) switches to Alphabetical or Last updated; while a sort is active, pinned projects (`pinOrder`) lead and alone keep Move/drag. Expanded projects live in `tau:expanded-projects`, pruned only after the first project fetch. Each project shows at most 5 roots before "show more".

### Clone a repository (`/api/projects/clone`)
"Clone here" in the Add-workspace picker clones into `<dir>/<repo name>` and registers it through `POST /api/projects`. Only `https://`, `ssh://` and scp-like URLs (`cloneDirectoryName`); git runs with `GIT_ALLOW_PROTOCOL=https:ssh` and `GIT_TERMINAL_PROMPT=0`. Jobs are daemon-owned (`workspace-clone.ts`): POST streams NDJSON, DELETE `{ id, hostId }` waits for exit and identity-checked cleanup (quarantine first; a raced replacement is preserved and its location reported). Existing targets are 409. Unobserved jobs cancel after two minutes.

### File access allow-list
- `/api/files` is not a filesystem browser. `workspace-roots.ts` discovers each daemon's sessions/projects, explicit validated grants, scratch directories and instruction roots. Session references grant reads only. Successful selection, default cwd and worktree operations grant roots on the owning daemon; browsing grants nothing. Main's `getAllowedFileRoots()` serves only local config/import/skills readers.
- Credential exclusions (`isPiSecretFile`, `lib/file-access.ts`) cover pi's `auth.json`, `mcp-auth.json`, legacy `oauth.json`, `models.json` and `mcp.json` (with copies and editor files) directly in an agent dir, tau's `tau-settings.json` (agent environment), and the whole `<agent dir>/tau/` tree (its key files also by hard-link identity). They apply to canonical targets and link aliases. Known secrets are denied first; a requested-path metadata failure answers 404 `file_not_found`; unavailable ownership metadata answers 503 `credential_policy_unavailable`. Never change user permissions automatically.
- The Explorer's listing hides nothing by name. It calls `listFilesInRoot(input, root)`: the listed directory's realpath must be inside the root's (403 `outside_root`), and symlinks that leave the root or dangle are flagged `outsideRoot` (dimmed, never expanded). The old `listFiles(input, showHidden)` op shares the implementation. `/api/file-index` follows `.gitignore` in a Git repo, else walks regular files under caps (breadth-first, asynchronous reads).
- `/api/file-search` (op `searchText`, the right panel's Search tab) is a literal, line-by-line search over the file index's listing of the cwd (refreshed on each search), so it follows `.gitignore`. It opens each file once (no-follow, non-blocking) and reads it, in a loop up to EOF, only if the path still names the opened file (device and inode) and its realpath is inside the cwd (a tracked directory swapped for a symlink still lists its old files), at most the 256 KiB preview size, and skips binary files (a NUL in the first 8 KiB). The full `isPiSecretFile` check (a directory read per call) runs on hard links, files under an agent or `tau` state directory, and the files entries there point to (a symlinked `auth.json`, matched by device and inode), and on every file when those directories or entries cannot be read (a dangling entry counts as absent). An unreadable path is skipped; 503 `credential_policy_unavailable` fails the search. It stops at 500 matches, after 10 s or when a newer search of the same cwd by the same `client` (one per Search panel) starts, answering `truncated`, and answers the `cwd` it searched (a session's own cwd, which results open against). A daemon without the op answers 501 `unknown_op`.
- **Workspace writes never touch pi's agent directory.** Every user-requested mutating workspace op (Files-panel upload check and publication, clone, worktree add/remove) runs `authorizeWritableDirectory`/`assertOutsideAgentDir` (`workspace-roots.ts`) on the daemon: a target that is, or after canonicalizing its nearest existing ancestor lies under, `getAgentDir()` or `~/.pi` (ancestors compared by device and inode, so symlinks, `..`, case and bind-mount aliases match) is refused 403 `agent_dir_read_only`. Reads are unchanged. The daemon's own composer `uploadAttach` into `<session dir>/local/uploads/` does not pass through it. A new mutating op must call it for every path it writes.
- `cacheSessionPath` (`session-reader.ts`) on main is filled by main's scans and local wrappers and only serves main-side readers.

### Session list caching — new sessions must appear immediately
- `listSessionsAllHosts()` (`lib/hosts/session-index.ts`) calls each host's `listSessions` op and caches it 30 s per host (`LIST_TTL_MS`). This machine's list is its daemon's; an offline host keeps its last list. `GET /api/sessions` also answers `unavailableHosts` (`unavailableSessionHosts()`: link down, never read since a restart, or the last read failed): a session missing from the list on those hosts is not gone, and the browser's chat tabs never close on it.
- **A lookup miss is not deletion while any host's list is unavailable.** `hostForSessionId()` returns no host only after successful current discovery across all registered hosts; otherwise retryable 503. Never guess a local owner or trust a caller's host hint.
- The daemon's `listAllSessions()` uses a 30 s list cache plus an mtime-keyed walk (`listSessionFiles`) keyed on the sessions root mtime, which NTFS does not bump for a new file in an existing subdirectory: `invalidateSessionListCache()` must also call `invalidateSessionFileListCache()` (regression test `lib/session-reader.test.mjs`).
- A mutation main triggers calls `invalidateLocalSessionLists()` (main's entry plus the daemon's `invalidateSessionLists` op); a route that changes session files without it leaves the sidebar stale for up to 30 s.
- Still read on main from this machine's files: `session-watcher.ts`, import, usage (`usage-db.ts`) and local file-reference readers, each with its own cache invalidation.

### Session archive and restore (`lib/pi/archive.ts`, `/api/sessions/archive`, `/api/sessions/[id]/archive`)
- Archive and restore run on the session's host (`archiveSession`, `listArchives`, `restoreArchive` ops); archives are `.jsonl.gz` under `<agent dir>/../archive/sessions` with their artifacts directory. The aggregate GET isolates failures per host (`unavailableHosts`, this machine included).
- **Restore needs proof the id is not active anywhere:** fresh strict discovery from every registered host (`listSessionIdsForRestore`, which bypasses caches and fails closed on any unreadable project, symlink or header). Any offline host blocks it (503 `host_offline` naming it); an incomplete inventory is 503 `host_sessions_unavailable`.
- **Claims** (`withArchiveRestoreLock`, `<agent dir>/tau/archive-restore-locks.sqlite`, table `restore_claims`, `synchronous = FULL`): a per-session lease renewed every 10 s. A remote restore is fenced at the daemon: main `restoreReserve`s a claim token, `hold`s it with the daemon's `instance`, then sends `restoreArchive`; it releases only on `ok` or `archive_restore_failed`. Everything else (silence, link loss, any other error, `archive_restore_not_admitted`) keeps the claim held (`archive_restore_unconfirmed`). A stale held claim is resolved by `restoreFence` only when the same `instance` answers with `running: false`. **Recovery limitation:** a claim whose daemon was replaced or restarted stays blocked for good; only an operator who verified that no daemon that could have taken it is running may delete that session's row.
- **Commit order** (`commitRestore`): under a filesystem-exclusive `<destination.jsonl>.restore-lock`, the source generation is pinned (`.restore-pin`) and captured (`.restore-consume`), artifacts move in first (`moveDirectoryNoReplace`), then the transcript is hard-linked, then the source is consumed; undo uses `takeBackTranscript`. `validateRestorePathSync` runs right before the moves. A transcript or artifacts already at the destination fails with 409 and is never merged or removed. A local restore runs the commit inside `BEGIN IMMEDIATE` on its claim row, synchronously. Discovery lists captures as `restorePending` evidence (Restore disabled), never as aliases; artifact trees are never scanned as archive entries; a corrupt gzip rejects the host's whole list (retention over availability). A process killed inside the commit leaves the claim and possibly partial moves for manual repair; power loss is not covered (no fsync, no journal, on purpose).

### Chat scroll-follow
`useAgentSession` follows the conversation on `messages` and `streamState`, throttled to one animation frame while running. A manual scroll-up disables following until the next prompt (`completionScrollAllowedRef`). A `ResizeObserver` (`ChatWindow`) keeps a reader at the bottom when the scroller changes height, judged by the previous height. Smooth scrolling respects `prefers-reduced-motion` (`usePrefersReducedMotion`). A jump to a search hit calls `holdScrollPosition()`.

### Search hits in the chat (`/api/sessions/[id]/matches`, `hooks/useChatSearchHighlights.ts`)
- With a sidebar query, each row lists its hits (`SessionSearchMatches`, 10 at a time). "Load more" asks for a longer prefix (`limit`), never an offset: a running session re-ranks.
- A hit is `(entryId, ordinal)`, counted per rendered text node in rendered order on both sides: the server (`session-match-listing.ts`) parses with the chat's remark parser; the chat counts in `[data-message-text][data-entry-id]`, skipping chrome (`NOT_MESSAGE_TEXT`). New chrome inside message text must be excluded there, and new text-rendering markdown counted in `renderedTextNodes`.
- Painting uses the CSS Custom Highlight API (`tau-search`, `tau-search-current` in `globals.css`). Each click target is used once (`onSearchTargetHandled`); an empty query clears everything.

### MCP configuration (`lib/pi/mcp-config.ts`, `/api/mcp`, `components/McpConfig.tsx`)
- The project file is `<cwd>/.pi/mcp.json` (pi reads it only for a trusted project, and from the session cwd, not the git top level); the user file is `<agent dir>/mcp.json`. Other apps' configurations are listed read-only as such; pi reads none of them. Server definitions support `stdio`, `http` and `sse` with exactly one of `command`/`url`, validated before any write. Writes are atomic under a cross-process lock and preserve unrelated keys; `previousName` renames.
- The endpoint follows the `/api/files` root rules and never exposes environment variables or headers.
- Configuration only: no live status or actions. tau never sends `/mcp` as a prompt; changes apply when a session starts or reloads.

### Plugins (pi packages) and skills
- `/api/plugins` shells out to the user's pi (`lib/pi/plugins-cli.ts`, `app/api/plugins/route.ts`): `pi list` (text, parsed by `parsePiListOutput`: "User packages:" / "Project packages:"), `pi install <source> [-l]`, `pi remove <source> [-l]`, `pi update [<source>|--extensions]`. There is no enable/disable. It runs in the project cwd, or the agent dir for the user level; a project-scope POST without `cwd` is 400 `cwd_required`.
- `/api/skills` lists through `lib/skills-service.ts`, a pure-Node scan of what pi 1.5.2 loads, in pi's precedence order: project `.pi/settings.json` `skills` paths, `<cwd>/.pi/skills`, `.agents/skills` from cwd up to the git root, user `settings.json` `skills`, `<agent dir>/skills`, `~/.agents/skills`, then package skills of the packages `pi list` prints (run with the project as the process cwd, never as an argument: `cmd.exe` would interpret `&`). The first name wins. Project skills are listed only when the project is trusted by the same rule as `--approve` (`projectTrusted`); settings/package filter patterns and ignore files are not replicated.
- Skill toggling edits only the `disable-model-invocation` frontmatter key (pi reads only that key, only a YAML `true`). Only user-owned skills are togglable (`getSkillToggleRoots()`, the one allowlist for PATCH and the `togglable` flag); never widen PATCH to whatever is listed.
- `/api/skills/install` runs `npx skills add ... --agent universal` (`.agents/skills`). Without `cwd`, `GET /api/plugins`, `GET /api/skills`, `POST /api/skills/check` and `/update` act on the user level only.

### Auth and model config
- Every host keeps its own pi logins in its `<agent dir>/auth.json`, which tau never reads. The auth routes (`app/api/auth/**`, `?hostId=`, default this machine) go through `lib/host-auth.ts` to that host's daemon (`auth` op, `lib/hosts/daemon-auth.ts`), which runs a pi of its own and calls `/tau_auth` (`providers`, `login`, `api_key`, `logout`). Logins stream steps (`tau_auth_event`) and ask for codes through `__tau_auth_prompt__` dialogs; the login SSE keeps pi-web's event names. Raw keys and tokens never leave pi; a typed key travels in as one command argument. `afterAuthChange` invalidates placement and the models cache.
- `/api/models` asks the utility pi (`get_available_models`, `/tau_auth providers`) on this machine; the cache is global (a `?cwd=` is ignored) and refreshed when `models.json` changes.
- The Models panel reads and writes `<agent dir>/models.json` (`lib/pi/models-config.ts`, unknown fields preserved; an unparseable file is never overwritten without an explicit opt-in). `models-config/catalog` searches models.dev for presets.
- `/api/pi-settings` edits allow-listed keys of pi's global `settings.json` (`lib/pi/settings-config.ts`).
- API-key status endpoints never return the raw key.

### Updates: web server and host software
- **Settings → System** prepares and reviews a durable server-and-host upgrade plan. `POST /api/app-update {action:"prepare"}` returns the plan; commit requires `{action:"commit",attemptId,approval:{planId,force}}`. Approval is bound to release identity and the registered-host/session snapshot. An incompatible host without a verified path blocks server cutover. The server worker (`self-update.ts`, `server-update-worker.ts`; a package builds a self-contained Node worker, a compiled release runs a private binary copy) stages and digest-checks the candidate, runs `tau preflight` in its environment, and only then stops anything (`upgrade-process.ts`). Completion needs an expected-version boot nonce and live process proof; a failed cutover keeps the prior tree and reports rollback status. See `docs/superpowers/specs/2026-11-14-coordinated-gui-upgrades-design.md`.
- **Settings → Hosts** updates individual daemons, this machine included, **only over the maintenance API**: without a maintenance connection `/api/hosts/[id]/updates` answers 503 `maintenance_unavailable`, and the application link has no update ops. The only target is `tau` (`HostUpdateTarget`); pi's version is shown, never updated (update pi with npm on the host). Normal `POST {target:"tau",version}` does not interrupt activity; `force:true` needs a distinct confirmation and may end sessions. `canForceUpdate` and machine-readable blockers govern the action. Force never waives integrity, ownership, process identity, `TAU_DISABLE_AUTOUPDATE`, local drains or service permissions. A candidate release without the `preflight` command fails the update and keeps the prior install. A daemon copies only `update-worker.ts`, whose startup must work without sibling modules; it accepts only tau descriptors (`process` and `releaseRepo` required). Source checkouts are manual-only.
- Persisted progress (`upgrade-plan.ts`, `self-update.ts`, `server-update-worker.ts`, `hosts/updates.ts`) decides success, never POST acceptance or shell output.

### Navigate back / forward (`lib/navigation-history.ts`, `hooks/useNavigationHistory.ts`)
- Browser-style back/forward over visited chat views, in memory per page load. It is tau's own stack, never the History API (the app only `router.replace`s `?session=`; real history belongs to the mobile back-gesture machinery, `useSidebarHistory`).
- AppShell records views from one effect keyed on `(selectedSession?.id, newSessionCwd)`; recording the current entry is a no-op, which makes back/forward self-suppressing. A step peeks, resolves the id via `/api/sessions`, then commits; a dead id is dropped and the next tried; a view change during the await aborts.
- Shortcuts (`useGlobalKeyboardShortcuts`): ⌘[/⌘], Alt+←/→ (not on macOS), mouse back/forward. The keystroke is always swallowed while a handler is registered, and skipped while a `[role="dialog"]` is open. Sidebar buttons hide below a 240px sidebar (`.sidebar-shell` container query).

### Composer file uploads (`docs/specs/2026-11-02-file-uploads-design.md`)
- Images and text files go inline within the inline budgets (`lib/image-attachments.ts`, `lib/chat-attachments.ts`); everything else, an image switched to **As file**, and anything over a budget is uploaded (2 GiB per file, 20 per message, `lib/upload-limits.ts`).
- Uploads land in a staging dir on the **session's host** (`lib/hosts/uploads.ts`, `<agent dir>/tau/uploads/`), never on main. The prompt carries `uploads: [id]`; `runAgentCommand` attaches each through `uploadAttach` (hard link into `<session dir>/local/uploads/`, never overwriting; copy on EXDEV; 10-minute op timeout) and appends an "Attached files" block naming each file by its absolute path. Ids stay registered until the prompt reaches pi. Attachment preparation holds the wrapper's pending-command protection, and later commands await the send fence (any alias of the wrapper). A prompt pushed past the link's line cap is refused 413 `request_too_large` and the uploads stay registered.
- **Transfer:** HTTP only. `POST /api/uploads` starts or resumes (`{ received, done }`), `PUT /api/uploads/[id]?offset=N` sends a chunk of at most 1 MiB, answered once the host acked it (409 `upload_offset` with `received`). Main relays the bytes as blob units on the host link (`putUploadChunk`, `lib/uploads.ts`); the host's `upload_ack`s are the flow control, and main stops an upload that runs too far ahead (429 `upload_window_exceeded`). Each host `uploadStart` carries a fresh `attempt`; superseded-attempt acks are discarded. Start/attach/abort share one per-id queue.
- `uploadFile` (`lib/event-stream.ts`) resumes 502/503/504 and network failures itself (same id, back-off, "Reconnecting…") until an outage reaches 5 min (`RESUME_GIVE_UP_MS`), then settles `upload_stalled` so Retry is usable. A bfcache pagehide fails with 410 and a new upload id.
- Limits on main: 32 unfinished uploads per owner (429 `too_many_uploads`); an entry idle 10 min leaves the registry (a later start re-registers it). The daemon's `sweep` deletes staged files and aborts open uploads idle over 24 h (`STAGED_MAX_AGE_MS`), at start, on every `uploadStart` and hourly; it never rejects.
- **Sent-upload retention** (`uploadRetentionDays`, default 30, `null` = never): main sends it with `setUploadRetention` at start, on every hello and on change (`upload-retention-sync.ts`); the daemon (`upload-retention.ts`) sweeps at start and every 24 h, deleting regular files older than that from `local/uploads/` of active and archived sessions, and from its own namespace of Windows' `<tmp>/tau-local/<id>/uploads/` (`uploadOwnerNamespace`). It skips symlinked directories and re-reads the policy before each unlink. Attach stamps the staged inode before hard-linking it; otherwise it writes only an exclusive copy. Sweep unlinks and every attach step that puts a file at a name run under `withUploadNameLock` (per daemon process). Files-panel publication cannot reach session upload folders (they are under the agent directory), so it neither stamps nor locks.
- **Durable cancels:** the tab hands `{op:"up_abort", id, host}` to the worker, which sends `DELETE /api/uploads/[id]?host=` (40 s deadline) until a 2xx or a 4xx other than 408/429. Main keeps an abort its host could not take and resends it on that host's next hello. A Retry of the same id supersedes it everywhere.
- Codes: `upload_id_conflict` (composer), `upload_conflict` (file manager).
- **Ownership:** `requestOwner(req)` (`lib/web-auth.ts`) binds start, chunks and cancel to the login. Attachment also accepts a server-issued completion proof (see the outbox) in the same installation/auth scope within 24 h; never caller-supplied owners or receipts. `uploadFile().promise` returns `{proof?}`; finished chips and drafts keep it. Completed receipts are durable until expiry, so a main restart does not lose a finished, unsent attachment. Switching chats aborts in-flight uploads.

### open_file
- The `open_file` host tool takes an absolute or workspace-relative path. pi has no `local://` scheme, and tau hands the agent none: the "Attached files" block names each upload by its absolute path.
- File reads, downloads and watches carry the tab's own `sessionId` and never follow an alias. Every file-tab URL uses `getFileApiUrl` with the tab's host and source session. `authorizeFileAccess` also admits the session's own local directory (`sessionLocalRootContaining`, `lib/session-local-files.ts`, on the owning daemon) for reads, downloads and watch only (never listing), confined by realpath, and applies `isPiSecretFile`. The watch re-authorizes its target and ends on a swap.

### Voice transcription (`lib/stt-jobs.ts`, `/api/stt`, `hooks/useDictation.ts`)
- Configured only by `TAU_STT_ENDPOINT` (with `TAU_STT_KEY`, `TAU_STT_MODEL`); without it dictation is off.
- The browser never waits on the endpoint: `POST /api/stt` keeps the recording in memory and starts a job; the hook polls `GET /api/stt/[jobId]` (job failures are 200 payloads, so proxy timeouts never surface as HTML).
- Jobs carry the composer scope (`draftKey`; `new:<cwd>` or `new:<hostId>:<cwd>` for new chats); the hook adopts the newest job of its scope on mount, focus, visibility and every 4 s while visible, so another browser can play, retry or discard it.
- Delivery is by claim: `DELETE ?claim=<instance token>&owner=<tab token>` returns the text to the first claim token; polls never carry text. The tab token (sessionStorage) identifies the owner, which gets a 15 s first claim and the stored send/queue choice (`after`, kept on the job, never only in component state). A `DELETE` without `claim` discards and aborts.
- The store is per process (caps: 4 pending, 20 live, TTLs); a restart loses jobs and the hook re-uploads its local copy.

### Completion sound
`hooks/useAudio.ts` stores the toggle (`tau-sound-enabled`) and reuses one `AudioContext`, unlocked from a user gesture in `ChatInput`; `ChatWindow` plays the tone from `onAgentEnd`.

### Notifications (`lib/notification-*.ts`, `public/sw.js`, Settings → Notifications)
- Detection runs on the server in `AgentSessionWrapper.handleFrame` (and `handleProcessExit`), so unwatched sessions notify. `createNotificationDetector()` inspects top-level frames only (subagent frames never notify). "Completed" fires on `session_settled`; a failed or aborted last prompt suppresses it. A refused message command reaches only the server that sent it (pi answers it only in that command's `response`). Failures arrive as `prompt_error` and `process_exit`; one failure per run. A crash notifies "Run failed" while a run or its background work is unsettled.
- **Presence vs streams.** Tabs report `{clientId, deviceId, visible, sessionId, seq}` to `/api/notifications/presence` (on change, input after idling, every 30 s; expires 60 s after receipt; `visible` = visible and input within 3 min; `sessionId` null while Settings hides the chat; an older `seq` is dropped). Streams are the tab's open `notifications` subscriptions. Prefs PUTs run one at a time.
- **Routing** (`routeNotification`): a visible tab on the session drops the event everywhere; else, with a visible connected tab, `whenActive: "toast"` devices get a toast on their active tabs; else push (subscribed devices) or in-page `showNotification`. The server decides before pushing (iOS revokes permission for silent pushes; `sw.js` always shows what it receives), so a settled dialog is retracted on the tab streams only (`{type: "notification-dismiss", tag, sessionId, requestId}`), never by a push.
- **Answering from a notification.** An `input` notification carries its blocking dialog (`confirm`, `select`, `input`, `editor`, `ask`) as `dialog` when the whole dialog fits the push budget, never clipped. `POST /api/notifications/answer {sessionId, requestId, response}` answers it through the same `ui_response` path the web dialog uses, checked against the pending dialog first (400 leaves it answerable); it never spawns pi (`sessionGone`, `alreadySettled` are 200s).
- Prefs and subscriptions are per device (`localStorage`, mirrored to the SQLite store in `<agent dir>/tau/`, 0600, WAL; it holds the VAPID key and the history). Push text is rendered server-side in the device's locale.
- `/sw.js` and `/badge-96.png` are ungated. Clicks survive an expired sign-in: `proxy.ts` sends `/?session=…` to `/login?next=…`, and `LoginForm` accepts only `/?…` targets.
- The history (`lib/notification-history.ts`, `/api/notifications/history`) keeps the newest 100 of every type some device enabled, already read when a visible tab shows that session; shown by `NotificationBell` (desktop popover) and the right panel's Notifications tab (mobile). Entries become read when the list closes, on Mark all as read or when opened (`OPEN_SESSION_EVENT`, `tau-open-session`); a reused id (`<sessionId>:<type>`) is unread again.

## Git history and PR landing rules

- **Never rewrite `main`'s history** (no force-push, `filter-branch`, rebase of pushed commits, or `reset --hard` plus force-push) unless the user explicitly asks for exactly that after being told what it affects. A badly worded commit title is not worth it.
- Never push or rewrite someone else's branch. Contributors' commits keep their hashes and authorship.
- Land PRs with a squash or rebase merge so each change is one commit with a normal title (`fix(scope): ...`). No throwaway integration branches (`scratch`, `pr-NNN`): their auto-titles end up in history. If PRs conflict (usually `CHANGELOG.md`), ask the authors to rebase, or resolve on a properly named branch.
- Before merging: CI green on the current head, mergeable, diff read. Pass the head SHA to the merge.

## Session File Format (pi, version 3)

Location: `<agent dir>/sessions/--<cwd without its leading separator, / \ : replaced by ->--/<timestamp>_<uuid>.jsonl`
(timestamp: ISO-8601 with `:` and `.` replaced by `-`).

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"timestamp":"...","provider":"...","modelId":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","timestamp":"...","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","timestamp":"...","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","timestamp":"...","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"<8hex>","parentId":"<8hex>","timestamp":"...","name":"..."}
{"type":"custom","id":"<8hex>","parentId":"<8hex>","customType":"client-message-entry","data":{...}}
```

- The `{"type":"session"}` header is pi's first line; pi's session listing skips a file whose first entry is not a
  header. `lib/pi/session-files.ts` migrates v1/v2 files in memory (`CURRENT_SESSION_VERSION` = 3).
- Entries form a tree via `(id, parentId)`; the leaf is the last entry. Other types (`thinking_level_change`, `label`,
  `branch_summary`, `custom_message`, `custom`, `session_info`, ...) must be tolerated; `session-reader.ts` renders
  `message` and `custom_message` and ignores the rest.
- pi names a session with `session_info` entries (the latest wins, an empty name clears it). tau renames a live
  session through pi's `set_session_name`; a file no pi holds gets one appended `session_info` entry under the last
  entry (`setSessionTitle`), never anything before the header. The listing scans the file for the latest one (resumed
  from the old end when the file grew); archived sessions are named from the first 128 KiB only.
- tau's own entries: `custom` `client-message-entry` / `client-message-resolution` (message identity and origin) and
  `custom` `tau_btw` (side questions).
- A session's artifacts (subagent transcripts, `local/`) live in the sibling directory `<file without .jsonl>/`.

`entryIds[]` in `SessionContext` is parallel to `messages[]`: each displayed message's entry id, used for fork and Edit.

---

## Design Tokens & UI Kit (`app/globals.css`, `components/ui/`)

Two themes, Light and Dark (plus System, which picks one by the OS), modelled on Pendant: warm paper and charcoal
surfaces with a muted blue accent. Every text/background pair is WCAG AA-verified (ratios noted in `globals.css`).
Add no further themes; change these two. Components must consume these variables, never hardcoded colors. On desktop the sidebar,
the chat and the docked right panel are rounded cards on `--bg-frame` (`.app-frame`); phones stay full-bleed.

```
color:  --bg --bg-panel --bg-hover --bg-selected --border --bg-subtle
        --text --text-muted --text-dim
        --accent --accent-strong --accent-hover   (links / filled buttons / hover)
        --user-bg --tool-bg --bg-frame (desktop frame behind the cards)
type:   --font-serif (display headings, class .display-serif; now the UI sans, the name is historical)  --font-mono
shape:  --radius-control (8) --radius-card (12) --radius-modal (16)
depth:  --shadow-card --shadow-pop --shadow-modal
motion: --dur-fast (150ms) --dur-med (220ms) --dur-slow (320ms) --ease-out-warm
```

`components/ui/` holds the shared primitives on `@base-ui/react`: `primitives.tsx` (Dialog/Tooltip/Collapsible),
`field.tsx` (form fields + ConfirmDialog), `toast.tsx` (`toast.success/error/info`, mounted in AppShell),
`ToggleSwitch.tsx`. Toasts are not stored. Toasts and notification rows dismiss on a sideways touch/pen swipe
(`data-swipe-dismiss`, skipped by the mobile sidebar gesture); `useDragClickGuard` swallows the click that ends a
drag; `createSwipeTracker` cancels a swipe the finger turned back (16px). The `onClick` option makes the whole card
the action. Icons come from `lucide-react`; do not add inline SVGs. The command palette (`CommandPalette.tsx`,
⌘K/Ctrl+K) is built on `cmdk`.
