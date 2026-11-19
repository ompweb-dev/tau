<div align="center">

<img src="public/icon.svg" alt="tau logo" width="150">

<h1>tau</h1>

</div>

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

tau is a browser workspace for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
It reads your pi sessions, runs live sessions through `pi --mode rpc` together with its companion pi extension, and
lets you chat with the agent, browse projects and files, and manage pi settings from any browser. One tau server can
also run sessions on other machines that you link to it.

## Features

- **Chat**: streaming replies, tool calls with live output, thinking blocks, queued follow-ups and steering, stop,
  and the `ask` tool's questions as dialogs.
- **Sessions**: browse past sessions per project, fork a session, switch between branches of a session, edit an
  earlier message, archive and restore, search titles and transcripts.
- **Messages survive interruptions**: a message to an existing session is held in the browser and on the server until
  pi has accepted it, across reconnects and restarts.
- **Files and Git**: file explorer and previews beside the chat, uploads into a session, Git worktrees.
- **Subagents**: progress and transcripts of `pi-subagents` runs, when
  that package is installed in pi.
- **Remote hosts and cluster**: run sessions on linked machines; group machines into a cluster that shares projects
  and this server's pi configuration.
- **Notifications**: in-page, desktop and Web Push (over HTTPS) for finished runs, questions and failures.
- **Agent tools** (off by default): cross-session tools and GitHub tools that use the server's `gh` login.
- **Voice input**: optional transcription through an endpoint you configure.

## Requirements

- **Node.js 24 or newer** for the npm package. The launcher (`tau`) runs on Node; the server runs on
  [Bun](https://bun.sh) 1.4.4 or newer, which the package installs as a dependency (a `bun` on your `PATH` of at
  least that version is used if the bundled one is missing). The [single binary](#single-binary) needs neither.
- **pi**, installed on every machine that runs sessions:

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

  tau runs the `pi` found on `PATH`. To use another one, set `TAU_PI_BIN` to its path. tau is developed against pi
  1.5.2. Without pi, browsing past sessions works, but no session can start.

## Install

### npm or Bun

```bash
npm install -g @ompweb-dev/tau
tau
```

`bun add -g @ompweb-dev/tau` installs the same package; the `tau` launcher still needs Node.js 24 on `PATH`.
`npx @ompweb-dev/tau@latest` runs it without a global install.

tau opens `http://127.0.0.1:30187` in your browser. Sign in to your model providers in **Settings → API Keys &
Providers** (see [Configuration](#configuration)), pick a workspace and start a session.

### Single binary

Each release also ships tau as one compiled program with the files it serves beside it:
`tau-linux-x64.tar.gz`, `tau-linux-arm64.tar.gz`, `tau-darwin-x64.tar.gz`, `tau-darwin-arm64.tar.gz` and
`tau-windows-x64.zip`. It needs no Node.js, npm or Bun of its own. It does not ship pi: it runs the `pi` on `PATH`
(or `TAU_PI_BIN`). Every commit on `main` that passes CI is also published as a prerelease with the same archives.

```bash
tar -xzf tau-linux-x64.tar.gz -C ~/.local/share   # unpacks tau-linux-x64/
~/.local/share/tau-linux-x64/tau                   # same options and environment variables as the npm launcher
```

- Keep `tau` in its directory: it serves `dist/`, `public/` and its pi extension from there (a symlink on your `PATH`
  works), or from `TAU_PACKAGE_DIR` when that is set.
- The binary has `tau host` and `tau hash-password`, but no tray and no service installer. Write service units
  yourself, as shown under [Services](#services).
- macOS quarantines downloads: run `xattr -dr com.apple.quarantine tau-darwin-arm64` once before the first start.
- macOS 15 and later ask before an app may reach your local network. If `tau host` reports `ECONNREFUSED` for a
  server on your LAN while `curl` reaches it, allow your terminal (or `tau`) under System Settings → Privacy &
  Security → Local Network.

### From source

```bash
git clone https://github.com/ompweb-dev/tau.git
cd tau
npm install
npm run build
node bin/tau.js
```

## Run

```text
tau [options]

  -p, --port <port>        Server port (default 30187, env PORT)
  -H, --hostname <host>    Bind hostname (default 127.0.0.1, env TAU_HOSTNAME)
      --no-open            Do not open the browser automatically
      --install-tray       Install the tray, background service and shortcuts (Windows; Linux SNI tray)
      --uninstall-tray     Uninstall them
      --tray               Start the background tray manager
  -h, --help               Show help
      --version            Show the version

tau hash-password          Read a password from stdin and print the value for TAU_PASSWORD_HASH
tau host ...               The host daemon (see "Hosts and cluster")
tau systemd ... | tau launchd ...   Forward to tau-systemd / tau-launchd
```

The production server also starts this machine's host daemon (`tau host`) if none is running: every session, local
ones included, runs under that daemon, so restarting the web server does not stop running sessions.

### Environment variables

| Variable | Meaning |
| --- | --- |
| `PORT` | Server port (default `30187`). |
| `TAU_HOSTNAME` | Bind address (default `127.0.0.1`). |
| `TAU_NO_OPEN` | `1`, `true`, `yes` or `on`: do not open a browser. |
| `TAU_PASSWORD_HASH` | Password hash from `tau hash-password`. Enables the sign-in page. |
| `TAU_TRUSTED_HEADER_SHA256` | SHA-256 hex digest of a secret that a trusted reverse proxy sends in `X-Tau-Auth` (see [below](#skipping-the-password-behind-a-trusted-proxy)). |
| `TAU_PI_BIN` | Path of the `pi` binary to run instead of the one on `PATH`. |
| `PI_CODING_AGENT_DIR` | pi's agent directory (default `~/.pi/agent`); tau reads and writes the same one. |
| `PI_CONFIG_DIR` | Name of pi's config directory in your home (default `.pi`). |
| `TAU_NAME` | Display name in the browser title. `url`, `host` or `domain` derive it from the request's host name. |
| `TAU_DISABLE_AUTOUPDATE` | `1`, `true`, `yes` or `on`: refuse in-app updates of the server and hosts. |
| `TAU_STT_ENDPOINT`, `TAU_STT_KEY`, `TAU_STT_MODEL` | Voice transcription: the endpoint receives a multipart `file` (and `model`), with `TAU_STT_KEY` as a bearer token. Without an endpoint, voice input is off. |
| `TAU_DISCONNECT_DESTROY_MS` | How long a session process may stay unwatched before it is stopped (default 2 minutes, `0` disables). |

### Password

Bound to `127.0.0.1`, tau needs no password. To listen on any other address, tau requires a password hash and
refuses to start without one:

```bash
tau hash-password                         # prompts, input hidden
echo "a-long-random-password" | tau hash-password
TAU_PASSWORD_HASH='scrypt$15$8$1$...' tau --hostname 0.0.0.0
```

tau accepts only the hash. The `--password` flag is refused. A plaintext `TAU_PASSWORD` is still detected: tau hashes
it at startup, removes it from its environment and prints a warning with the hash to use instead (set together with
`TAU_PASSWORD_HASH`, it is refused). The reason: every pi session inherits tau's environment, so an agent could print a
plaintext password into its transcript. Browser sign-ins last 30 days.

### Behind a reverse proxy

Without TLS, tau warns when it listens on a non-loopback address. Serve it over HTTPS through a reverse proxy or a
VPN, and keep tau itself bound to `127.0.0.1`. The proxy must pass WebSocket upgrades (the browser uses
`/api/events/link`, hosts use `/api/hosts/link` and `/api/hosts/maintenance`). It must not add its own authentication
on the paths that hosts authenticate with their token: `/api/hosts/link`, `/api/hosts/maintenance` and
`/api/hosts/cluster-config/…`.

#### Skipping the password behind a trusted proxy

tau cannot see client addresses itself, so a reverse proxy can vouch for requests instead. The proxy sends a secret in
the `X-Tau-Auth` header, and tau holds only the secret's SHA-256 digest in `TAU_TRUSTED_HEADER_SHA256`. A request whose
header hashes to that digest counts as signed in. Without a password hash there is nothing to skip.

Generate a long random secret without putting it on a command line. This writes it into an nginx include file and
prints only the digest:

```bash
secret=$(openssl rand -hex 32)
printf 'map $tau_trusted $tau_auth {\n    1        "%s";\n    default  "";\n}\n' "$secret" \
  | sudo install -m 0640 -o root -g www-data /dev/stdin /etc/nginx/tau-auth.conf
printf %s "$secret" | sha256sum | cut -d' ' -f1
unset secret
```

```nginx
# http {} context
geo $tau_trusted {
    default       0;
    10.0.0.0/16   1;
}
include /etc/nginx/tau-auth.conf;

# the location that proxies to tau
proxy_set_header X-Tau-Auth $tau_auth;
```

Always set the header, so the empty value replaces any `X-Tau-Auth` a client sends. Give tau's `server` block an
explicit `server_name` and answer other host names with `return 444;` in a `default_server` block, so DNS rebinding
cannot make nginx add the secret to another site's requests. tau stores only a fast SHA-256 digest, which is safe only
for a long random secret: never reuse a password here.

## Services

Each installer runs two services: the web server and the host daemon (`tau host`).

### Linux (systemd user services)

```bash
TAU_PASSWORD_HASH='scrypt$...' tau-systemd install   # or: npx --yes --package=@ompweb-dev/tau@latest tau-systemd install
tau-systemd status
```

`install` writes the units `tau.service` and `tau-host.service` to `~/.config/systemd/user/`, creates
`~/.pi/agent/web-service.env` (port, hostname, password hash; edit it without reinstalling) and enables both. Other
commands: `uninstall` (`--clean-config` also removes the env file), `start`, `stop`, `restart` (web service only),
`open`. Options: `--port`, `--hostname`, `--no-autostart`, `--json`. Logs:
`journalctl --user -u tau -u tau-host -f`.

On KDE Plasma and other StatusNotifierItem desktops, `tau --install-tray` adds a tray icon that controls these
systemd services.

### macOS (launchd)

```bash
TAU_PASSWORD_HASH='scrypt$...' tau-launchd install   # or: npx -p @ompweb-dev/tau@latest tau-launchd install
tau-launchd status
tau-launchd uninstall
```

`install` creates the LaunchAgents `dev.ompweb.tau` and `dev.ompweb.tau-host`, which start at login and restart on
crash. It reads `PORT`, `TAU_HOSTNAME`, `TAU_PASSWORD_HASH`, `TAU_TRUSTED_HEADER_SHA256`, `TAU_PI_BIN`, `TAU_NAME`,
`TAU_DISABLE_AUTOUPDATE` and `PI_CODING_AGENT_DIR` from the environment it runs in. Logs go to `~/Library/Logs/tau`.

### Windows (tray and background service)

```powershell
tau --install-tray
```

This installs the background service, the host daemon (scheduled task `tau-host`), a tray icon, logon autostart and
Desktop/Start Menu shortcuts. `tau-tray status|start|stop|restart|open|uninstall` manage it. The service reads its
settings from `%USERPROFILE%\.pi\agent\web-service.json`, and `TAU_PASSWORD_HASH` from your user or system environment.

### Single binary as a service

Write the two units yourself. For systemd (adjust the paths):

```ini
# ~/.config/systemd/user/tau.service
[Unit]
Description=tau web service

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/tau-linux-x64/tau --no-open
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# TAU_PASSWORD_HASH, PORT and TAU_HOSTNAME go here.
EnvironmentFile=-%h/.pi/agent/web-service.env
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/tau-host.service
[Unit]
Description=tau host daemon
# It exits until the web server has written its link: keep restarting.
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/tau-linux-x64/tau host
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.pi/agent/web-service.env
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now tau tau-host
```

`PATH` must contain the directory of `pi` (and of the Node.js that pi runs on). On macOS, two launchd agents running
`…/tau --no-open` and `…/tau host` with `RunAtLoad` and `KeepAlive` do the same; on Windows, two Task Scheduler tasks
running `tau.exe --no-open` and `tau.exe host` at logon.

## Hosts and cluster

### The host daemon

`tau host` is the process that runs pi sessions on a machine and reads its session files. It dials out to one or more
tau servers over a WebSocket, so it can sit behind NAT. Sessions keep running when the link or the web server goes
away, and the server rejoins them when the link returns. On the server's own machine the daemon is linked
automatically ("This machine" in **Settings → Hosts**).

```text
tau host login [--add] --url <server url>   save a link; the host token is read from stdin
tau host logout --url <server url>          remove a link
tau host [--allow-http]                     run the daemon
tau host status|drain|resume                control the running daemon
```

The daemon accepts only `https://` server URLs, or `http://` for a loopback address. `--allow-http` allows plain HTTP
to other addresses; use it only on a network you trust, since the host token then travels unencrypted.

### Link another machine

The other machine needs pi, and tau from npm (Node.js 24) or the single binary.

1. On the tau server, open **Settings → Hosts → Add host**, enter a name and copy the token. It is shown once; the
   server stores only its hash.
2. On the other machine, save the link. Paste the token when asked, or pipe it in; it never appears in `ps`:

   ```bash
   npx @ompweb-dev/tau@latest host login --url https://tau.example.com
   ```

   The link is saved in `~/.pi/agent/tau/host.json` with mode `600`. `--add` adds a link to a further server instead
   of replacing the first one.
3. Run the daemon and keep it running (as a service, see [Services](#services)):

   ```bash
   npx @ompweb-dev/tau@latest host
   ```

The host then shows as online, the sidebar groups its workspaces, and the new-session screen offers it. Each host keeps
its own `~/.pi/agent`, sessions and provider logins. **Settings → Hosts** also renames and revokes hosts, shows each
host's tau version and offers updates, and sets whether agents may start sessions there without asking. A revoked
host's daemon stops its sessions.

### Cluster

**Settings → Hosts** can add linked hosts to a cluster; this machine is its master and joins with the first host. A
host must be online to join, and gives a projects folder for the cluster's checkouts. Its Git projects are bound to
cluster projects by their repository origin. A cluster session can then start on any member.

Members run sessions with the master's pi configuration. The master builds a versioned manifest of:

- from its pi agent directory: `settings.json`, `models.json`, `mcp.json`, `AGENTS.override.md`, `AGENTS.md`,
  `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, and the directories `skills/`, `prompts/`, `themes/` and
  `extensions/`;
- `~/.agents/skills/`;
- the agent environment variables of **Settings → System**.

Each member's daemon downloads the files it lacks, checks their hashes and applies the version whole or not at all. The
master checks every 30 seconds, and a session start on a member applies the current version first. A mirrored
directory becomes equal to the master's (`node_modules` and `.git` are left out). Limits: 5 MiB per file, 50 MiB in all.

Not mirrored: credentials (`auth.json`, `mcp-auth.json`), sessions, caches, configuration inside a repository, and
programs (an MCP server's command, or a package that `settings.json` names, which pi installs on the member itself). A
member keeps its own values of these `settings.json` keys: `shellPath`, `shellCommandPrefix`, `npmCommand`,
`selfUpdateCommand`, `externalEditor`, `sessionDir`, `httpProxy`, `extensions`, `skills`, `prompts`, `themes`,
`deviceId`, `trackingId`, `lastChangelogVersion`, `extensionChangelogVersions` and `terminal`.

On first apply the member's own configuration moves to `~/.pi/agent/tau/own-config/`; leaving the cluster puts it back.
A host holds one server's configuration at a time. Provider logins are never mirrored: log in on each member (see
below).

## Configuration

tau uses pi's own files and adds a few of its own:

| Path | Contents |
| --- | --- |
| `~/.pi/agent/settings.json` | pi settings; **Settings** edits default thinking level, thinking-block display, enabled models, retry and compaction. |
| `~/.pi/agent/models.json` | Custom providers and models; edited in **Settings → API Keys & Providers**. |
| `~/.pi/agent/auth.json` | pi's provider logins and API keys, written by pi. |
| `~/.pi/agent/sessions/` | pi session files, which tau lists and reads. |
| `~/.pi/agent/tau-settings.json` | tau server settings: auto-resume after restart, agent tools, GitHub write and Actions permissions, agent environment variables, upload retention. |
| `~/.pi/agent/projects.json` | Workspaces added to or hidden from the sidebar. |
| `~/.pi/agent/tau/` | tau state: host registry (`hosts.json`), the daemon's links (`host.json`), cluster (`pools.json`), sign-in key, notifications, message outbox, uploads. |
| `~/.pi/agent/web-service.env` | Service settings written by `tau-systemd` (`web-service.json` on Windows). |

All paths follow `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR`.

**Provider logins are per host.** tau never reads `auth.json` itself. Logins (OAuth and API keys) run inside pi through
tau's companion extension (the `/tau_auth` command of `lib/pi/tau-extension.ts`), on the selected host's daemon; raw
keys and tokens stay with pi on that host. Choose the host in **Settings → API Keys & Providers** to log in there.

**Agent environment variables** (**Settings → System**) are added to every pi process started afterwards. Names that
would redirect pi's state or tau's plumbing are refused: `PATH`, `PATHEXT`, `COMSPEC`, `SYSTEMROOT`, `WINDIR`,
`NODE_OPTIONS`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
`PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `PI_PROFILE`, `PORT`, `NODE_ENV`, and anything starting with `TAU_` or `_`.

## Security notes

- **An agent runs with your user's rights.** pi's tools can read and write any file your user can and run commands.
  tau does not sandbox it. Anyone who can sign in to tau can make an agent do that on every linked host.
- **Password gate.** With `TAU_PASSWORD_HASH` set, every page and API route except the sign-in page, static assets,
  the service worker and the host-authenticated paths needs a session cookie (or the trusted proxy header). tau
  refuses to listen on a non-loopback address without a password hash.
- **HTTPS.** tau speaks plain HTTP. Put it behind HTTPS (reverse proxy or VPN) for any remote access, so the password,
  the session cookie and host tokens stay private. Web Push notifications also need HTTPS.
- **Secrets stay out of sessions.** `TAU_PASSWORD`, `TAU_PASSWORD_HASH`, `TAU_TRUSTED_HEADER_SECRET`,
  `TAU_TRUSTED_HEADER_SHA256`, `TAU_STT_KEY`, `PORT` and `NODE_ENV` are removed from the environment of every pi
  process and project command.
- **Host tokens.** The server stores only the SHA-256 of each host token. A host's daemon reads its token from stdin
  and keeps it in a mode-`600` file. A revoked token is refused at once.
- **File access in the browser.** The file viewer and explorer serve only allowed roots: workspaces you added or
  opened, session working directories and validated worktrees, and the files a session's transcript references (read
  only). Known credential files in pi's directory (`models.json`, `.env` files) are refused even inside an allowed
  root. These limits apply to the browser, not to the agent.
- **Agent tools are off by default.** When enabled, any session can list sessions, start a session or send a message
  to another one, and use the GitHub tools with the server's `gh` login. Comments and thread writes ask in the session
  unless **Allow agent GitHub writes without asking** is on, and Actions dispatch, cancel and rerun each ask by default.
  Starting a session on a host asks unless that host allows agent starts.

## Development

```bash
npm install
npm run dev            # Bun hot reload at http://127.0.0.1:30188
npm run build          # bundle the browser app into dist/
npm start              # serve dist/ at http://127.0.0.1:30187
npm run build:binary   # single binary for this machine into release/ (-- --target bun-linux-arm64 for another)
npm run typecheck && npm run lint && npm test
```

The dev server does not take over the host daemon: "This machine" shows offline in dev, and the daemon stays linked to
your installed tau.

## License

MIT, see [LICENSE](./LICENSE). tau is forked from [ompweb](https://github.com/ompweb-dev/ompweb), which was forked from
[agegr/pi-web](https://github.com/agegr/pi-web).
