<div align="center">

<img src="public/icon.svg" alt="tau logo" width="150">

<h1>tau</h1>

</div>

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

tau 是 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的浏览器工作区。
它读取你的 pi 会话，通过 `pi --mode rpc` 加上配套的 pi 扩展运行实时会话，让你在任何浏览器中与智能体对话、浏览项目和文件、管理 pi 设置。一台 tau 服务器还可以在你链接给它的其他机器上运行会话。

## 功能

- **对话**：流式回复、带实时输出的工具调用、思考块、排队的后续消息与引导（steer）、停止，以及以对话框显示的 `ask` 工具问题。
- **会话**：按项目浏览历史会话、分叉会话、在会话内切换分支、编辑之前的消息、归档与恢复、搜索标题和对话记录。
- **消息不怕中断**：发给已有会话的消息会保存在浏览器和服务器上，直到 pi 接收为止，可跨越重连和重启。
- **文件与 Git**：对话旁的文件浏览器与预览、上传文件到会话、Git worktree。
- **子智能体**：如果 pi 中安装了 `pi-subagents` 包，显示其运行进度和对话记录。
- **远程主机与集群**：在已链接的机器上运行会话；把机器组成集群，共享项目和本服务器的 pi 配置。
- **通知**：运行完成、等待回答的问题和失败时，通过页内、桌面和 Web Push（需 HTTPS）通知。
- **智能体工具**（默认关闭）：跨会话工具，以及使用服务器 `gh` 登录的 GitHub 工具。
- **语音输入**：可选，通过你配置的端点转写。

## 环境要求

- npm 包需要 `PATH` 上的 **[Bun](https://bun.sh) 1.4.4 或更高版本**：tau 的一切（`tau` 命令、服务器、`tau host` 和托盘）都运行在 Bun 上。[单一可执行文件](#单一可执行文件)自带 Bun。
- 每台运行会话的机器都要安装 **pi**：

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

  tau 运行 `PATH` 上的 `pi`。要使用其他 pi，把 `TAU_PI_BIN` 设为它的路径。tau 基于 pi 1.5.2 开发。没有 pi 时仍可浏览历史会话，但无法启动会话。

## 安装

### npm 或 Bun

```bash
bun add -g @ompweb-dev/tau
tau
```

`npm install -g @ompweb-dev/tau` 安装的是同一个包；两种方式下命令都运行在 `PATH` 上的 `bun` 上。`bunx @ompweb-dev/tau@latest` 无需全局安装即可运行。

tau 会在浏览器中打开 `http://127.0.0.1:30187`。在 **Settings → API Keys & Providers** 中登录你的模型提供商（见[配置](#配置)），选择工作区并开始会话。

### 单一可执行文件

每个版本还提供编译成单个程序的 tau，它要提供的文件放在旁边：
`tau-linux-x64.tar.gz`、`tau-linux-arm64.tar.gz`、`tau-darwin-x64.tar.gz`、`tau-darwin-arm64.tar.gz` 和 `tau-windows-x64.zip`。它自身不需要 Node.js、npm 或 Bun。它不包含 pi：它运行 `PATH` 上的 `pi`（或 `TAU_PI_BIN`）。`main` 上每个通过 CI 的提交也会发布为带有相同压缩包的预发布版本。

```bash
tar -xzf tau-linux-x64.tar.gz -C ~/.local/share   # unpacks tau-linux-x64/
~/.local/share/tau-linux-x64/tau                   # same options and environment variables as the npm launcher
```

- 把 `tau` 留在它的目录中：它从那里提供 `dist/`、`public/` 和它的 pi 扩展（可以在 `PATH` 上放一个符号链接），设置了 `TAU_PACKAGE_DIR` 时则从该目录提供。
- 该程序有 `tau host` 和 `tau hash-password`，但没有托盘和服务安装器。服务单元需要自己编写，见[服务](#服务)中的示例。
- macOS 会隔离下载的文件：首次启动前运行一次 `xattr -dr com.apple.quarantine tau-darwin-arm64`。
- macOS 15 及以后版本会在应用访问本地网络前询问。如果 `curl` 能访问局域网中的服务器，而 `tau host` 报告 `ECONNREFUSED`，请在“系统设置 → 隐私与安全性 → 本地网络”中允许你的终端（或 `tau`）。

### 从源码运行

```bash
git clone https://github.com/ompweb-dev/tau.git
cd tau
npm install
npm run build
bun bin/tau.js
```

## 运行

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

生产服务器在本机的主机守护进程（`tau host`）未运行时会启动它：所有会话（包括本地会话）都在这个守护进程下运行，因此重启 Web 服务器不会停止正在运行的会话。

### 环境变量

| 变量 | 含义 |
| --- | --- |
| `PORT` | 服务器端口（默认 `30187`）。 |
| `TAU_HOSTNAME` | 绑定地址（默认 `127.0.0.1`）。 |
| `TAU_NO_OPEN` | `1`、`true`、`yes` 或 `on`：不打开浏览器。 |
| `TAU_PASSWORD_HASH` | `tau hash-password` 输出的密码哈希。启用登录页。 |
| `TAU_TRUSTED_HEADER_SHA256` | 受信任的反向代理在 `X-Tau-Auth` 中发送的密钥的 SHA-256 摘要（十六进制），见[下文](#在受信任的代理后跳过密码)。 |
| `TAU_PI_BIN` | 用来代替 `PATH` 上那个 `pi` 的可执行文件路径。 |
| `PI_CODING_AGENT_DIR` | pi 的 agent 目录（默认 `~/.pi/agent`）；tau 读写同一个目录。 |
| `TAU_NAME` | 浏览器标题中的显示名称。`url`、`host` 或 `domain` 表示取自请求的主机名。 |
| `TAU_DISABLE_AUTOUPDATE` | `1`、`true`、`yes` 或 `on`：拒绝服务器和主机的应用内更新。 |
| `TAU_STT_ENDPOINT`、`TAU_STT_KEY`、`TAU_STT_MODEL` | 语音转写：端点接收 multipart 的 `file`（和 `model`），`TAU_STT_KEY` 作为 Bearer 令牌发送。未设置端点时语音输入关闭。 |
| `TAU_DISCONNECT_DESTROY_MS` | 无人查看的会话进程在多久后停止（默认 2 分钟，`0` 表示禁用）。 |

### 密码

绑定到 `127.0.0.1` 时，tau 不需要密码。要监听其他地址，tau 必须有密码哈希，否则拒绝启动：

```bash
tau hash-password                         # prompts, input hidden
echo "a-long-random-password" | tau hash-password
TAU_PASSWORD_HASH='scrypt$15$8$1$...' tau --hostname 0.0.0.0
```

tau 只接受哈希。`--password` 参数会被拒绝。明文的 `TAU_PASSWORD` 仍会被检测到：tau 在启动时对它做哈希，从自己的环境中删除它，并在警告中打印应改用的哈希（与 `TAU_PASSWORD_HASH` 同时设置则会被拒绝）。原因是每个 pi 会话都继承 tau 的环境，智能体可能把明文密码打印到对话记录中。浏览器登录有效期为 30 天。

### 在反向代理之后

在非回环地址上无 TLS 监听时，tau 会发出警告。请通过反向代理或 VPN 以 HTTPS 提供服务，并让 tau 本身绑定到 `127.0.0.1`。代理必须转发 WebSocket 升级（主机使用 `/api/hosts/link` 和 `/api/hosts/maintenance`）。对于主机用令牌认证的路径（`/api/hosts/link`、`/api/hosts/maintenance` 和 `/api/hosts/cluster-config/…`），代理不得再加自己的认证。

#### 在受信任的代理后跳过密码

tau 自己看不到客户端地址，因此可以由反向代理为请求担保。代理在 `X-Tau-Auth` 请求头中发送一个密钥，tau 只在 `TAU_TRUSTED_HEADER_SHA256` 中保存该密钥的 SHA-256 摘要。请求头哈希与摘要一致的请求视为已登录。没有密码哈希时，就没有可跳过的东西。

生成一个长的随机密钥，且不要把它写在命令行上。下面的命令把它写入 nginx 的 include 文件，只打印摘要：

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

始终设置该请求头，这样客户端自己发送的 `X-Tau-Auth` 会被空值替换。给 tau 的 `server` 块设置明确的 `server_name`，并在 `default_server` 块中对其他主机名 `return 444;`，以免 DNS 重绑定让 nginx 把密钥加到其他站点的请求上。tau 只保存快速的 SHA-256 摘要，这只对长的随机密钥安全：不要在这里复用密码。

## 服务

每个安装器都运行两个服务：Web 服务器和主机守护进程（`tau host`）。

### Linux（systemd 用户服务）

```bash
TAU_PASSWORD_HASH='scrypt$...' tau-systemd install   # or: npx --yes --package=@ompweb-dev/tau@latest tau-systemd install
tau-systemd status
```

`install` 把单元 `tau.service` 和 `tau-host.service` 写入 `~/.config/systemd/user/`，创建 `~/.pi/agent/web-service.env`（端口、主机名、密码哈希；修改后无需重新安装），并启用两者。其他命令：`uninstall`（`--clean-config` 同时删除 env 文件）、`start`、`stop`、`restart`（仅 Web 服务）、`open`。选项：`--port`、`--hostname`、`--no-autostart`、`--json`。日志：`journalctl --user -u tau -u tau-host -f`。

在 KDE Plasma 等支持 StatusNotifierItem 的桌面上，`tau --install-tray` 会添加一个控制这些 systemd 服务的托盘图标。

### macOS（launchd）

```bash
TAU_PASSWORD_HASH='scrypt$...' tau-launchd install   # or: npx -p @ompweb-dev/tau@latest tau-launchd install
tau-launchd status
tau-launchd uninstall
```

`install` 创建 LaunchAgent `dev.ompweb.tau` 和 `dev.ompweb.tau-host`，它们在登录时启动，崩溃后重启。它从运行时的环境中读取 `PORT`、`TAU_HOSTNAME`、`TAU_PASSWORD_HASH`、`TAU_TRUSTED_HEADER_SHA256`、`TAU_PI_BIN`、`TAU_NAME`、`TAU_DISABLE_AUTOUPDATE` 和 `PI_CODING_AGENT_DIR`。日志写入 `~/Library/Logs/tau`。

### Windows（托盘和后台服务）

```powershell
tau --install-tray
```

这会安装后台服务、主机守护进程（计划任务 `tau-host`）、托盘图标、登录时自启动以及桌面和开始菜单快捷方式。用 `tau-tray status|start|stop|restart|open|uninstall` 管理。服务从 `%USERPROFILE%\.pi\agent\web-service.json` 读取设置，从用户或系统环境变量读取 `TAU_PASSWORD_HASH`。

### 把单一可执行文件作为服务

自己编写两个单元。以 systemd 为例（按需调整路径）：

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

`PATH` 必须包含 `pi` 所在目录（以及 pi 所用 Node.js 的目录）。在 macOS 上，两个以 `RunAtLoad` 和 `KeepAlive` 运行 `…/tau --no-open` 与 `…/tau host` 的 launchd agent 可以实现同样效果；在 Windows 上，则是两个在登录时运行 `tau.exe --no-open` 与 `tau.exe host` 的任务计划程序任务。

## 主机与集群

### 主机守护进程

`tau host` 是在一台机器上运行 pi 会话并读取其会话文件的进程。它通过 WebSocket 主动连接一个或多个 tau 服务器，因此可以位于 NAT 之后。链接或 Web 服务器断开时会话继续运行，链接恢复后服务器重新加入这些会话。在服务器自己的机器上，守护进程会自动链接（**Settings → Hosts** 中的“This machine”）。

```text
tau host login [--add] --url <server url>   save a link; the host token is read from stdin
tau host logout --url <server url>          remove a link
tau host [--allow-http]                     run the daemon
tau host status|drain|resume                control the running daemon
```

守护进程只接受 `https://` 服务器地址，`http://` 仅限回环地址。`--allow-http` 允许对其他地址使用明文 HTTP；此时主机令牌以未加密方式传输，只应在受信任的网络中使用。

### 链接另一台机器

另一台机器需要 pi，以及 npm 版 tau（需要 Bun）或单一可执行文件。

1. 在 tau 服务器上打开 **Settings → Hosts → Add host**，输入名称并复制令牌。令牌只显示一次；服务器只保存其哈希。
2. 在另一台机器上保存链接。按提示粘贴令牌，或通过管道传入；它不会出现在 `ps` 中：

   ```bash
   tau host login --url https://tau.example.com
   ```

   链接以 `600` 权限保存到 `~/.pi/agent/tau/host.json`。`--add` 会添加到另一台服务器的链接，而不是替换第一个。
3. 运行守护进程并保持运行（作为服务运行，见[服务](#服务)）：

   ```bash
   tau host
   ```

之后该主机显示为在线，侧边栏为它的工作区分组，新建会话界面也可以选择它。每台主机保留自己的 `~/.pi/agent`、会话和提供商登录。**Settings → Hosts** 还可以重命名和撤销主机、显示每台主机的 tau 版本并提供更新，以及设置智能体能否无需询问就在该主机上启动会话。被撤销主机的守护进程会停止它的会话。

### 集群

在 **Settings → Hosts** 中可以把已链接的主机加入集群；本机是主节点（master），随第一台主机一起加入。加入的主机必须在线，并提供一个用于集群检出的项目文件夹。它的 Git 项目按仓库 origin 绑定到集群项目。之后集群会话可以在任一成员上启动。

成员使用主节点的 pi 配置运行会话。主节点构建一个带版本的清单，包括：

- 来自其 pi agent 目录：`settings.json`、`models.json`、`mcp.json`、`AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`，以及目录 `skills/`、`prompts/`、`themes/` 和 `extensions/`；
- `~/.agents/skills/`；
- **Settings → System** 中的智能体环境变量。

每个成员的守护进程下载缺少的文件，校验其哈希，并整体应用该版本，要么全部应用，要么完全不应用。主节点每 30 秒检查一次，在成员上启动会话时会先应用当前版本。被镜像的目录会变得与主节点的完全相同（排除 `node_modules` 和 `.git`）。限制：单个文件 5 MiB，总计 50 MiB。

不镜像的内容：凭据（`auth.json`、`mcp-auth.json`）、会话、缓存、仓库内的配置，以及程序（MCP 服务器的命令，或 `settings.json` 指定的包，后者由 pi 在成员上自行安装）。成员对 `settings.json` 中的以下键保留自己的值：`shellPath`、`shellCommandPrefix`、`npmCommand`、`selfUpdateCommand`、`externalEditor`、`sessionDir`、`httpProxy`、`extensions`、`skills`、`prompts`、`themes`、`deviceId`、`trackingId`、`lastChangelogVersion`、`extensionChangelogVersions` 和 `terminal`。

首次应用时，成员自己的配置会移到 `~/.pi/agent/tau/own-config/`；离开集群时再放回去。一台主机同一时间只持有一个服务器的配置。提供商登录永远不会被镜像：请在每个成员上分别登录（见下文）。

## 配置

tau 使用 pi 自己的文件，并增加几个自己的文件：

| 路径 | 内容 |
| --- | --- |
| `~/.pi/agent/settings.json` | pi 设置；**Settings** 可编辑默认思考级别、思考块显示、启用的模型、重试和压缩（compaction）。 |
| `~/.pi/agent/models.json` | 自定义提供商和模型；在 **Settings → API Keys & Providers** 中编辑。 |
| `~/.pi/agent/auth.json` | pi 的提供商登录和 API 密钥，由 pi 写入。 |
| `~/.pi/agent/sessions/` | pi 会话文件，tau 列出并读取它们。 |
| `~/.pi/agent/tau-settings.json` | tau 服务器设置：重启后自动恢复、智能体工具、GitHub 写入和 Actions 权限、智能体环境变量、上传保留期。 |
| `~/.pi/agent/projects.json` | 添加到侧边栏或从侧边栏隐藏的工作区。 |
| `~/.pi/agent/tau/` | tau 状态：主机注册表（`hosts.json`）、守护进程的链接（`host.json`）、集群（`pools.json`）、登录签名密钥、通知、消息发件箱、上传。 |
| `~/.pi/agent/web-service.env` | `tau-systemd` 写入的服务设置（Windows 上为 `web-service.json`）。 |

所有路径都遵循 `PI_CODING_AGENT_DIR`。

**提供商登录按主机分别保存。** tau 自己从不读取 `auth.json`。登录（OAuth 和 API 密钥）在所选主机的守护进程上、通过 tau 的配套扩展（`lib/pi/tau-extension.ts` 中的 `/tau_auth` 命令）在 pi 内部完成；原始密钥和令牌留在该主机的 pi 中。要在某台主机上登录，请在 **Settings → API Keys & Providers** 中选择该主机。

**智能体环境变量**（**Settings → System**）会加到之后启动的每个 pi 进程中。会改变 pi 状态位置或 tau 内部机制的名称会被拒绝：`PATH`、`PATHEXT`、`COMSPEC`、`SYSTEMROOT`、`WINDIR`、`NODE_OPTIONS`、`HOME`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME`、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、`PORT`、`NODE_ENV`，以及所有以 `TAU_` 或 `_` 开头的名称。

## 安全说明

- **智能体以你的用户权限运行。** pi 的工具可以读写你的用户能访问的任何文件并执行命令。tau 不对其做沙箱隔离。任何能登录 tau 的人，都能让智能体在每台已链接的主机上这样做。
- **密码门。** 设置 `TAU_PASSWORD_HASH` 后，除登录页、静态资源、Service Worker 和主机认证的路径外，所有页面和 API 路由都需要会话 Cookie（或受信任代理的请求头）。没有密码哈希时，tau 拒绝监听非回环地址。
- **HTTPS。** tau 使用明文 HTTP。任何远程访问都应放在 HTTPS（反向代理或 VPN）之后，以保护密码、会话 Cookie 和主机令牌。Web Push 通知也需要 HTTPS。
- **密钥不会进入会话。** `TAU_PASSWORD`、`TAU_PASSWORD_HASH`、`TAU_TRUSTED_HEADER_SECRET`、`TAU_TRUSTED_HEADER_SHA256`、`TAU_STT_KEY`、`PORT` 和 `NODE_ENV` 会从每个 pi 进程和项目命令的环境中移除。
- **主机令牌。** 服务器只保存每个主机令牌的 SHA-256。主机守护进程从标准输入读取令牌，并保存在权限为 `600` 的文件中。被撤销的令牌会立即被拒绝。
- **浏览器中的文件访问。** 文件查看器和浏览器只提供允许的根目录：你添加或打开过的工作区、会话的工作目录和经过验证的 worktree，以及会话对话记录引用的文件（只读）。即使在允许的根目录内，pi 目录中已知的凭据文件（`models.json`、`.env` 文件）也会被拒绝。这些限制针对浏览器，不针对智能体。
- **智能体工具默认关闭。** 启用后，任何会话都可以列出会话、启动会话或向另一个会话发送消息，并使用服务器 `gh` 登录的 GitHub 工具。除非开启 **Allow agent GitHub writes without asking**，评论和讨论串写入会在会话中询问；Actions 的 dispatch、cancel 和 rerun 默认各自询问。在某台主机上启动会话时，除非该主机允许智能体启动，否则会询问。

## 开发

```bash
npm install
npm run dev            # Bun hot reload at http://127.0.0.1:30188
npm run build          # bundle the browser app into dist/
npm start              # serve dist/ at http://127.0.0.1:30187
npm run build:binary   # single binary for this machine into release/ (-- --target bun-linux-arm64 for another)
npm run typecheck && npm run lint && npm test
```

开发服务器不会接管主机守护进程：开发时“This machine”显示为离线，守护进程仍链接到你已安装的 tau。

## 许可证

MIT，见 [LICENSE](./LICENSE)。tau 派生自 [ompweb](https://github.com/ompweb-dev/ompweb)，而 ompweb 派生自 [agegr/pi-web](https://github.com/agegr/pi-web)。
