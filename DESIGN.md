# tau — Product & Architecture Contract

## Purpose

tau is a local, browser-based workspace for the
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent
(`@earendil-works/pi-coding-agent`, tested with 1.5.2). It lets a user browse the
same local sessions they use in the terminal, continue live work, configure
supported pi settings, and inspect project files without creating a second agent
runtime or a second source of truth.

tau is forked from ompweb, the browser UI for oh-my-pi, which itself originated
from [agegr/pi-web](https://github.com/agegr/pi-web) (MIT). We preserve the
license and attribution. Upstream changes are ported for their behavior, not
merged unchanged.

## Product principles

1. **pi remains authoritative.** Sessions, credentials, providers, packages and
   agent behavior belong to pi. tau must not invent a parallel data format or
   credential store.
2. **Local-first by default.** The server binds to `127.0.0.1`; remote access
   is an explicit user choice and must be protected by a trusted network
   boundary and HTTPS.
3. **Node-first installation.** A normal user installs Node.js 24+ and pi, then
   runs `tau` from the npm package (`@ompweb-dev/tau`) or a release binary. The
   npm package brings its own Bun for the web server, so users do not install Bun
   themselves. tau never ships pi: it runs the `pi` on `PATH`.
4. **Native compatibility over imitation.** Prefer pi's RPC mode, its extension
   API, its CLI and its documented on-disk formats to copied SDK internals. If a
   capability cannot be done safely through those boundaries, leave it out rather
   than emulating it speculatively.
5. **A calm, capable workspace.** The UI should make active work, session
   history, configuration, and project context understandable without hiding the
   agent's state or expanding the app into a general remote-control plane.

## Distribution and identity

- npm package `@ompweb-dev/tau`; CLI command `tau` (plus the `tau-tray`,
  `tau-launchd` and `tau-systemd` service helpers). Release binaries
  `tau-<os>-<arch>` hold the server, `tau host` and `tau hash-password`.
- Default server address: `http://127.0.0.1:30187` (`-p`/`PORT`).
- Configuration uses the `TAU_*` prefix: `TAU_HOSTNAME`, `TAU_NO_OPEN`,
  `TAU_PI_BIN` (the `pi` binary; default `pi` on `PATH`), `TAU_PASSWORD_HASH`,
  `TAU_TRUSTED_HEADER_SHA256`, `TAU_STT_*`, `TAU_DISABLE_AUTOUPDATE`.
  `TAU_PASSWORD` is accepted only as a migration step (see the security contract).
- `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) and `PI_CONFIG_DIR` are respected
  because they identify the user's existing pi state. tau's own state lives in
  `<agent dir>/tau/` and `<agent dir>/tau-settings.json`.
- The UI displays its own version separately from the detected pi version; those
  versions may legitimately differ.

## Runtime architecture

```
Browser
  │ HTTP / Server-Sent Events (one SharedWorker EventSource per browser)
  ▼
tau (Bun server, started by the Node launcher)
  ├─ serves the SPA, the API and the password gate
  └─ reaches every machine through its `tau host` daemon (the link)
       │
       ▼
     tau host ── one `pi --mode rpc --extension …/tau-extension.ts` child per active session
       │          (pi's RPC JSONL over stdio)
       ▼
     pi and the existing ~/.pi/agent state
```

### The pi boundary

pi's SDK packages are TypeScript tied to pi's internals. Importing
`@earendil-works/*` (or `@oh-my-pi/*`) into the tau server or daemon would tie tau
to those internals and make the application unreliable, so neither process may
depend on them at runtime. Rules tau needs from pi (agent-directory resolution,
skill discovery, `settings.json` and `models.json` shapes) are replicated in
`lib/pi/` and `lib/skills-service.ts`, pinned to the pi version they mirror.

Live work goes through pi's own RPC mode: `spawnPiTransport`
(`lib/pi/rpc-process.ts`) runs `pi --mode rpc --extension <tau-extension.ts>`
with the sanitized child environment, and `RpcProcess` speaks pi's NDJSON
commands, responses and events. What pi's RPC mode does not cover goes through
tau's companion extension, `lib/pi/tau-extension.ts`, which pi loads from tau's
package directory (`TAU_PACKAGE_DIR`, never the session's cwd) and which uses
only pi's public extension API: host tools and the `ask` dialog bridged over
`extension_ui_request` input dialogs (`__tau_host_tool__`, `__tau_ask__`), message
identity and origin (`/tau_meta`, recorded as `client-message-entry` custom
entries), `/btw` side questions (`/tau_btw`), history Edit (`/tau_edit`,
`navigateTree`) and provider logins (`/tau_auth`, through pi's own model
runtime). `lib/rpc-manager.ts` maps tau's command set onto these (for example
`abort_and_restore_queue`, `get_btw_history`). Package operations (`pi list`,
`pi install`, ...) run the installed `pi` CLI (`lib/pi/plugins-cli.ts`); skills
are listed by a pure-Node scan that mirrors pi's discovery, plus `pi list` for
package skills (`lib/skills-service.ts`).

### The Host seam

Every machine-local action of a session goes through one interface, `Host`
(`lib/hosts/host.ts`): spawning pi, checking that a session file exists,
invalidating cached session lists, and the file-reading operations behind the
session, project and workspace routes. The web server has no direct path to any
machine, its own included: it reaches every host through the link described
below. The implementation on the web server is `RemoteHost` (`hub.ts`); the
daemon (`tau host`) runs the other side, `localHost` (`local-host.ts`), on the
machine whose pi it owns.

```
Browser ─▶ tau ◀── link (loopback WebSocket) ── tau host ── spawn pi --mode rpc (stdio)
              ◀── link (WebSocket)           ── tau host on another machine
                                                  └─ spawn pi --mode rpc
```

"This machine" is the host with the fixed id `local`, linked to the daemon that
the service installers set up next to the web service (production also starts a
missing one itself, `local-daemon-start.ts`). Because the daemon owns the pi
processes, restarting or redeploying the web server does not end a run: the
restarted server joins the live children from the daemon's hello, with their open
blocking requests replayed. One daemon may link several web servers; it owns
session lifecycle and fans events out to every joined server. A direct spawn path
would tie every run to the web server's lifetime, which is why none exists; the
short-lived utility pi (`lib/pi/rpc-utility.ts`) is the one deliberate exception,
and it is not a session.

The pi boundary holds on every machine: a remote machine runs its own pi, its own
`~/.pi/agent` and its own credentials. A host that joins the cluster (Settings →
Hosts) additionally receives this machine's pi configuration
(`settings.json` minus machine-local keys, `models.json`, `mcp.json`, context
files, skills; `lib/hosts/cluster-config.ts`), applied by its daemon; credentials
are never mirrored. tau only routes. `RpcProcess` takes its byte pipe
(`RpcTransport`) from the host, so the session wrapper, event streams,
notifications and queue handle frames without knowing where pi runs. Session
routes address a session by id; the owning host resolves the file path, so a
remote path never reaches the serving machine's filesystem.

The application link is one WebSocket that the `tau host` daemon opens to the
server (`/api/hosts/link`, link protocol v1, `lib/hosts/link-protocol.ts`): text
frames carry sequenced, acked messages in both directions, large lines travel in
pieces, and binary frames carry large op results (daemon → server) and upload
bytes (server → daemon). The daemon forwards pi's NDJSON unchanged and answers a
fixed allow-list of host operations (`HOST_OP_NAMES`); there is no generic exec
or file-read operation. Updates and inventory use a second, separately versioned
WebSocket, the maintenance API v1 (`/api/hosts/maintenance`,
`lib/hosts/maintenance-protocol.ts`: `status`, `listSessions`, `checkUpdates`,
`updateSoftware`), so an upgrade still reaches a host whose application protocol
differs. A host is trusted like the serving machine: control of the server or of
a host token is a shell on that host. Tokens are stored hashed, shown once, and
revocable, and the daemon requires `https://` except for loopback or an explicit
`--allow-http`. The full protocol is in `docs/specs/2026-10-28-remote-hosts-design.md`.

## Data and mutation boundaries

### pi-owned state

- `~/.pi/agent` (or `PI_CODING_AGENT_DIR`) is the source of truth for sessions,
  `settings.json`, `models.json`, skills, packages and blobs.
- `auth.json` holds credentials. tau never reads or writes it itself;
  authentication actions go through pi (`/tau_auth` in the companion extension,
  run by a pi process).
- A live pi process owns writes to its session file. tau routes supported live
  actions through RPC and the extension and never races a live file rewrite.

### Direct file access

Session browsing is implemented in pure Node against pi's JSONL files. The reader
tolerates older session shapes, resolves blob references when needed, and builds
the active branch context from the entry tree. The session and project routes run
it in the daemon of the session's host (`session-ops.ts`), so the same code serves
this machine and every linked one.

Direct session mutation is deliberately narrow and explicit: rename/title,
archive, deletion, and required branch-parent maintenance. These writes are
atomic where possible; archive or deletion stops the associated live process
first. tau does not provide a general editor for session JSONL or opaque pi
state.

Models (`models.json`) and allow-listed pi settings (`settings.json`) use
surgical JSON updates that preserve unrelated keys (`lib/pi/models-config.ts`,
`lib/pi/settings-config.ts`). Package operations run the installed `pi` CLI. MCP
configuration is project-local, validated before writing, and saved atomically.

### Reconnect and foreground catch-up

Completed conversation history is identified by persisted session entry IDs.
Live `message_end` frames have no durable ID and can arrive before pi writes the
entry, so they trigger catch-up rather than append an unidentified copy.
Streaming text, active tool output, and an optimistic user prompt remain separate
from confirmed history.

`GET /api/sessions/:id/context?sync=1` returns a `SessionSyncResponse`:

- `cursor` contains `firstEntryId` and `lastEntryId` (both null for empty
  history). Send its JSON value in the next request's `cursor` query parameter.
- `mode: "append"` returns only messages after that position; `baseEntryId`
  identifies the expected client prefix. An orphaned cursor or changed
  compaction prefix returns `mode: "replace"`.
- `context.messages` and `context.entryIds` remain aligned. `limit` is an
  integer from 1 to 200 (default 200); follow `hasMore` with the returned cursor.
  Only the selected page's image blobs are resolved.
- `leafId`, `includePreCompaction`, `deferThinking`, and `deferMedia` view
  parameters remain available. A historical view excludes live output.
- `live` contains the web-owned process's current partial message, active tool
  snapshots, and lifecycle flags, or null for a file-only session. Reading
  history never starts a pi process. A live process can supply its first partial
  before its session file exists, but a missing file cannot erase a nonempty
  confirmed cursor.
- `live.responseObserved` retains positive visible-answer evidence for the
  current run after completion, even before its entry is readable on disk. New
  runs and process/session changes reset it; tool calls alone do not count.

`GET /api/sessions/:id/context?boundary=1` returns only `{ entryIds }` for the
current active context. Prompt and interrupt dispatch use this fresh ID-only
boundary instead of downloading the transcript. It shares the history index
without hydrating message bodies or blobs and cannot be combined with sync,
pagination, or historical-view parameters.

SSE events carry `web: { streamId, sequence }`. The stream epoch changes when the
native process or session identity changes. These values order live snapshots;
they are not a persisted replay journal or `Last-Event-ID` support. Subscription
precedes the `connected` cursor announcement. The client keeps processing live
events while history loads and applies snapshot fields only when they cannot
overwrite newer message, tool, or lifecycle state.

Open/reopen, foreground/online, message completion, and persisted-file
notifications share one coalesced catch-up loop. Pages are accumulated privately
and published only when the selected history is complete. Failed reads retain the
last complete cursor and displayed history. Overlapping full loads preserve newer
complete history rather than treating an intermediate page as authoritative. Full
initial loads and terminal metadata refreshes still update the branch tree. A
completion or persistence notification during an in-flight read schedules one
follow-up read from the newly returned cursor. Raw SSE completions never append a
second copy of an entry that the history response already includes.

Unchanged history pages reuse a file-versioned offset index and seek only the
requested message bodies. The in-memory index cache is bounded to 32 views and
32 MiB of charged metadata; it does not retain transcript bodies or increase the
256 MiB raw-file cache budget or 1 GiB load ceiling. Cold indexes and changed
files require a full metadata scan. Growth alone is not proof of an append: the
same inode can be rewritten and then extended, so any file version change
invalidates offsets rather than trusting an unchecked prefix. Failed reads never
advance the confirmed cursor.

File-only catch-up also refreshes model and thinking metadata without replacing
newer or pending choices. Replacement observer connections restore browser
registrations and the subagent roster only after successfully connecting.

## Security contract

- Bind loopback-only by default. A non-loopback hostname is an explicit opt-in.
- `TAU_PASSWORD_HASH` protects every route with a password-only sign-in screen.
  Only a scrypt hash reaches the server (`tau hash-password`), because every pi
  session inherits the server's environment and an agent could print the password
  into its transcript, session file and model-provider traffic. `--password`, or a
  plaintext `TAU_PASSWORD` next to a hash, refuses to start. A lone
  `TAU_PASSWORD` is hashed by the launcher, removed from the server's
  environment, and logged as a warning with the hash to use instead; the server
  itself still refuses a plaintext. Successful sign-in creates an HTTP-only,
  signed cookie with a 30-day expiry; the signing key is a per-installation
  random value mixed with the hash, so a copied password hash cannot forge a
  session and changing the password still invalidates existing sessions. Exposed
  deployments require HTTPS through a trusted reverse proxy or VPN. With
  `TAU_TRUSTED_HEADER_SHA256` set, a request whose `X-Tau-Auth` header hashes to
  that digest counts as signed in; tau never holds the secret itself. Deciding
  which clients get the header is the reverse proxy's job, because tau has no
  client address it can trust.
- tau's own secrets (`TAU_SECRET_ENV_VARS`: `TAU_PASSWORD`, `TAU_PASSWORD_HASH`,
  `TAU_TRUSTED_HEADER_SHA256` and its legacy name `TAU_TRUSTED_HEADER_SECRET`)
  are stripped from every child process environment through
  `createChildProcessEnvironment` (`lib/project-command-env.ts`). `TAU_*` values
  that are configuration rather than secrets (`TAU_PACKAGE_DIR`, `TAU_PI_BIN`,
  ...) are kept.
- API requests are origin-checked. Do not add browser-to-host execution paths
  that bypass this boundary.
- Host tools come from a fixed set: the browser's own tools (open a URL or file,
  notify) and the server's session tools in `lib/agent-tools.ts`
  (`list_sessions`, `new_session`, `send_to_session`, the GitHub tools); none runs
  a host command. A browser request must not become arbitrary host command
  execution through an extension callback.
- File APIs are not a general filesystem browser. They are restricted to selected
  workspaces, valid Git worktrees, session-referenced files, a session's own
  `local/` directory (uploads), and explicitly selected roots. Paths are canonicalized to
  reject traversal and symlink escapes, and the agent directory's credential and
  model files stay private (`isPiSecretFile`, `lib/file-access.ts`).
- Secrets, raw API keys, and credential store contents never appear in API
  responses, logs, or the browser.

## UX contract

- The session sidebar is the durable navigation model: projects, sessions,
  branches, worktrees, and files must agree about the selected workspace.
- Streaming state is explicit. The UI reconciles Server-Sent Events with the
  session's state so a background tab cannot remain falsely “running”.
- Desktop and mobile share the same core workflow. Mobile controls keep usable
  touch targets and a visible loading state rather than a blank shell.
- Accessibility and motion preferences are first-class. Components use the shared
  design tokens and UI primitives rather than one-off colors or controls.
- Expensive rendering is deferred until needed; responsiveness and initial bundle
  size are part of the product contract.

## Upstream and release strategy

ompweb and `agegr/pi-web` are historical sources of UI ideas, bug fixes, and
tests. Before adopting a change from either, verify that it does not depend on
oh-my-pi runtime behavior (ompweb's runner, omp-only RPC commands) or on SDK
internals. Port the user-visible behavior, not blindly the implementation.

Releases are independent; `docs/release.md` holds the checklist. Each `v*` tag
runs the tests, the production build and the smoke tests against the pinned pi
(`PI_VERSION` in the workflows), builds the five release binaries
(`scripts/build-release-binaries.sh`), publishes the GitHub Release and then the
npm package through trusted publishing.

## Non-goals

- Reimplementing pi, its provider registry, or its credential store.
- Embedding pi SDK packages in the tau server or daemon.
- Turning a local agent workspace into an internet-facing multi-user service.
- Unrestricted filesystem browsing or arbitrary browser-triggered host tools.
- Automatic bulk synchronization from ompweb or `agegr/pi-web`.

When a proposed feature conflicts with one of these boundaries, preserve the
boundary unless the design is intentionally revised first.
