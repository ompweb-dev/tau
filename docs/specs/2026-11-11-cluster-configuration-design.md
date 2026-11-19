# Cluster members use the master's pi configuration — design

Date: 2026-11-11. Branch: `feat/cluster-config` (on `feat/cluster-membership` 4176e5b7).
Builds on: `docs/specs/2026-11-11-cluster-membership-design.md` (the cluster, its master, joining and leaving). Written for ompweb's omp (`config.yml`, `models.yml`, `omp plugin`, credential sharing); updated for tau and pi 1.5.2, which `MIRRORED` and `LOCAL_SETTINGS` in `lib/hosts/cluster-config.ts` follow.

Facts about pi in this document come from pi 1.5.2 (`dist/core/settings-manager`, `package-manager`, `resource-loader`); the code names the version it mirrors.

## Why

A cluster session can run on any member, but each member reads its own pi configuration. The model picker, `models.json`, the settings screens, MCP servers, skills and packages in the interface are the master's. A session placed on another member therefore runs with different models, tools and rules than the interface shows, and the panels for MCP, Skills and Packages say "Not available on remote hosts yet".

pi cannot fetch configuration from another machine, and most of it cannot be pointed elsewhere: `settings.json`, `models.json`, user MCP servers, skills, prompts, extensions and context files are read only from the machine's own pi directory.

Goal: every member runs cluster sessions with the master's configuration. Changing it on the master, in the interface or on disk, reaches the members without any action on them.

Not goals:

- Standalone hosts. A linked host outside the cluster keeps its own configuration, managed on that machine; the panels stay unavailable for it.
- Installing programs. An MCP server's command, a language server or a local model engine that exists only on the master is not installed on members; the interface says what is missing where.
- Configuration inside a repository (`.pi/` in the project). It travels with the checkout already.
- The remaining differences between this machine and remote hosts that are not configuration: transcript search, usage analytics, session import, and the file views of a cluster chat that has no node yet. They get their own plan.

## Decisions

### K1. What is mirrored

From the master's pi agent directory (`~/.pi/agent`) unless another place is named (`MIRRORED`):

| Part | Files |
|---|---|
| Settings | `settings.json`, without the keys of K2 (its `packages` list is how packages travel, K5) |
| Models | `models.json` |
| MCP servers (user level) | `mcp.json` |
| Skills | `skills/`, and `~/.agents/skills/` (where the interface installs them) |
| Context and system prompts | `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md` (every context candidate, so a member's own cannot shadow the master's) |
| Prompts, themes, extensions | `prompts/`, `themes/`, `extensions/` |
| Environment | the "agent environment variables" of Settings → System |

A mirrored directory becomes equal to the master's: files that exist only on the member are removed from it. The member's backup (K6) holds its configuration as it was at the first apply; a file added on the member later is removed at the next apply and is not backed up.

Limits per file 5 MiB, per bundle 50 MiB, and 5 MiB for the list of files (many small files can exceed it); `node_modules` and `.git` directories are left out. A master configuration over a limit is not mirrored at all, and Settings says which file is over, or that there are too many.

Not mirrored: credentials (`auth.json`, `mcp-auth.json`), sessions, caches (`npm/`, `git/`, `bin/`).

### K2. Settings that stay the member's own

These `settings.json` keys describe the machine or the installation (`LOCAL_SETTINGS`). The member keeps its own value for each, or none:

`shellPath`, `shellCommandPrefix`, `npmCommand`, `selfUpdateCommand`, `externalEditor`, `sessionDir`, `httpProxy`, `extensions`, `skills`, `prompts`, `themes`, `deviceId`, `trackingId`, `lastChangelogVersion`, `extensionChangelogVersions`, `terminal`, `showHardwareCursor`, `fullscreenWheelScrollLines`.

The list is one constant, used by the master when it builds the bundle and by the member when it merges.

### K3. How it gets there

- **Version.** The master computes the configuration's version: a hash over the path and content hash of every mirrored file and the agent environment variables. It recomputes when the interface writes a configuration file and when a watched file changes on disk.
- **Pull.** A member's daemon fetches the list of files for a version, and each file it lacks by content hash, from two routes under `/api/hosts/cluster-config/`. They are authenticated with the host token and answer only members; a standalone host gets 403.
- **Apply.** The daemon writes each file with mode 0600 to a temporary name and renames it, removes what the list no longer has, merges `settings.json` (K2), and records the applied version. Either the whole version is applied or the previous one stays.
- **When.** After joining; when the master announces a new version over the link; and before every session start on a member: `open.launch` carries the master's version, and the daemon applies it first if its own differs.
- Link protocol v1 carries the version in `open.launch.configVersion`, the `clusterConfig` op (`apply`/`restore`) and the member's `config_state` report of its applied version.

### K4. A member that is not current

- **New cluster sessions** are placed only on members whose applied version is the master's and whose files are current. A member that is behind is skipped, as a draining one is.
- **A session that must run on one member** (a resumed session, a project pinned to its node): the daemon applies the files first. If that fails, the start is refused with the reason; the session is never started with the member's own configuration.
- Sessions already running are not restarted.
- Settings → Hosts shows each member's state: current; updating; failed, with the reason; and the MCP server commands that are not installed there.

### K5. Packages

- tau mirrors no package list of its own: pi packages are named in `settings.json` (`packages`), which is mirrored (K1), and pi installs the missing ones itself when a session starts on the member. This needs network access on the member.
- An earlier design ran `omp plugin` on each member and reported a separate plugin state; tau has neither.

### K6. Joining and leaving

- **Joining.** Before the first apply, the daemon moves the member's own version of every mirrored file and directory into `<agent dir>/tau/own-config/` The confirmation of joining says that the host's configuration is replaced until it leaves.
- **Changes made on a member** to a mirrored file are overwritten at the next apply. Configuration is changed on the master.
- **Leaving.** The daemon removes the mirrored files, moves the backup into place, Failures are shown. Its `settings.json` is its own file again, unchanged.
- This machine is the master: nothing is mirrored to it and nothing of it is backed up.

### K7. The settings screens

- For a session or project of the cluster, whichever member runs it, the Models, settings, MCP, Skills and Packages screens act on the master's configuration, as they do for this machine today, and say that it applies to the whole cluster.
- The model picker needs no change: with the same `models.json`, a member's models are the master's where it has logins for their providers (logins are never mirrored), except for providers that depend on the machine (below).
- Live MCP status of a running session still comes from that session's own process.

## Security

- The bundle holds secrets: API keys in `models.json`, MCP server environment and headers, and agent environment variables. They are written to every member's disk, readable by the daemon's user only.
- Extensions and packages are code. The master's code runs on every member. The master can already start pi with full tool access there.
- Nothing flows the other way: a member cannot change the master's configuration, and the routes only serve.
- The routes answer members only, check membership on every request, and stop answering a host the moment it leaves or is revoked.

## Limits

- A provider in `models.json` that points at the master's own address (`http://127.0.0.1:11434`) points at the member's own address there. A local engine has to run on each member, or be given an address the members can reach.
- An API key written as an environment-variable name, or as a `!command`, resolves on the member: the variable or the command has to exist there. Variables set in Settings → System do.
- MCP servers started by a command need that command on each member.

## Testing

- Bundle building: every part of K1; the keys of K2 removed; the limits; `node_modules` left out; the version changes when any input changes and only then.
- The routes: host token; member only; revoked or left host; unknown version; a file requested by a hash that is not in the current version.
- Apply on a member, in a temporary agent directory: first apply makes the backup; directories become equal to the master's; `settings.json` keeps the member's own K2 keys; a failure half-way leaves the previous version in place; leaving restores every file byte for byte.
- Session start: a member that is behind applies first; a failed apply refuses the start; placement skips a member that is not current.
- Settings: the panels for a cluster session act on the master; the per-member state.
- Live, with the user: a change to `models.json` and a new skill on the master appear in a session started on another member.

## Documentation

`README.md`, `AGENTS.md`, `CHANGELOG.md`, the remote-hosts specification's version rule, and the Settings strings in English, Chinese and Japanese.
