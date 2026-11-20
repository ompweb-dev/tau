<div align="center">

<img src="public/icon.svg" alt="tau logo" width="150">

<h1>tau</h1>

</div>

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

tau 是 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的瀏覽器工作區。
它讀取你的 pi 工作階段，透過 `pi --mode rpc` 搭配隨附的 pi 擴充功能執行即時工作階段，讓你在任何瀏覽器中與代理對話、瀏覽專案和檔案、管理 pi 設定。一台 tau 伺服器也能在你連結給它的其他機器上執行工作階段。

## 功能

- **對話**：串流回覆、帶即時輸出的工具呼叫、思考區塊、排入佇列的後續訊息與引導（steer）、停止，以及以對話框顯示的 `ask` 工具問題。
- **工作階段**：依專案瀏覽過往工作階段、分叉工作階段、在工作階段內切換分支、編輯先前的訊息、封存與還原、搜尋標題和對話紀錄。
- **訊息不怕中斷**：傳給既有工作階段的訊息會保存在瀏覽器和伺服器上，直到 pi 接收為止，可跨越重新連線和重新啟動。
- **檔案與 Git**：對話旁的檔案總管與預覽、上傳檔案到工作階段、Git worktree。
- **子代理**：若 pi 中安裝了 `pi-subagents` 套件，顯示其執行進度和對話紀錄。
- **遠端主機與叢集**：在已連結的機器上執行工作階段；把機器組成叢集，共用專案和本伺服器的 pi 設定。
- **通知**：執行完成、等待回答的問題和失敗時，透過頁內、桌面和 Web Push（需 HTTPS）通知。
- **代理工具**（預設關閉）：跨工作階段工具，以及使用伺服器 `gh` 登入的 GitHub 工具。
- **語音輸入**：選用，透過你設定的端點轉寫。

## 系統需求

- npm 套件需要 **Node.js 24 或更新版本**。啟動器（`tau`）在 Node 上執行；伺服器在 [Bun](https://bun.sh) 1.4.4 或更新版本上執行，Bun 會作為套件的相依項目自動安裝（若內建的 Bun 不存在，則使用 `PATH` 上不低於該版本的 `bun`）。[單一執行檔](#單一執行檔)兩者都不需要。
- 每台執行工作階段的機器都要安裝 **pi**：

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

  tau 執行 `PATH` 上的 `pi`。要使用其他 pi，請把 `TAU_PI_BIN` 設為它的路徑。tau 以 pi 1.5.2 為開發基準。沒有 pi 時仍可瀏覽過往工作階段，但無法啟動工作階段。

## 安裝

### npm 或 Bun

```bash
npm install -g @ompweb-dev/tau
tau
```

`bun add -g @ompweb-dev/tau` 安裝的是同一個套件；`tau` 啟動器仍需要 `PATH` 上的 Node.js 24。`npx @ompweb-dev/tau@latest` 不必全域安裝即可執行。

tau 會在瀏覽器中開啟 `http://127.0.0.1:30187`。在 **Settings → API Keys & Providers** 中登入你的模型供應商（見[設定](#設定)），選擇工作區並開始工作階段。

### 單一執行檔

每個版本也提供編譯成單一程式的 tau，它要提供的檔案放在旁邊：
`tau-linux-x64.tar.gz`、`tau-linux-arm64.tar.gz`、`tau-darwin-x64.tar.gz`、`tau-darwin-arm64.tar.gz` 和 `tau-windows-x64.zip`。它本身不需要 Node.js、npm 或 Bun。它不包含 pi：它執行 `PATH` 上的 `pi`（或 `TAU_PI_BIN`）。`main` 上每個通過 CI 的提交也會發布為帶有相同壓縮檔的預先發布版本。

```bash
tar -xzf tau-linux-x64.tar.gz -C ~/.local/share   # unpacks tau-linux-x64/
~/.local/share/tau-linux-x64/tau                   # same options and environment variables as the npm launcher
```

- 把 `tau` 留在它的目錄中：它從那裡提供 `dist/`、`public/` 和它的 pi 擴充功能（可以在 `PATH` 上放一個符號連結），設定了 `TAU_PACKAGE_DIR` 時則從該目錄提供。
- 此執行檔有 `tau host` 和 `tau hash-password`，但沒有系統匣和服務安裝程式。服務單元需要自行撰寫，見[服務](#服務)中的範例。
- macOS 會隔離下載的檔案：首次啟動前執行一次 `xattr -dr com.apple.quarantine tau-darwin-arm64`。
- macOS 15 及之後的版本會在應用程式存取本機網路前詢問。如果 `curl` 能連到區域網路中的伺服器，而 `tau host` 回報 `ECONNREFUSED`，請在「系統設定 → 隱私權與安全性 → 本機網路」中允許你的終端機（或 `tau`）。

### 從原始碼執行

```bash
git clone https://github.com/ompweb-dev/tau.git
cd tau
npm install
npm run build
node bin/tau.js
```

## 執行

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

正式環境的伺服器在本機的主機常駐程式（`tau host`）未執行時會啟動它：所有工作階段（包括本機的）都在這個常駐程式下執行，因此重新啟動 Web 伺服器不會停止正在執行的工作階段。

### 環境變數

| 變數 | 意義 |
| --- | --- |
| `PORT` | 伺服器連接埠（預設 `30187`）。 |
| `TAU_HOSTNAME` | 繫結位址（預設 `127.0.0.1`）。 |
| `TAU_NO_OPEN` | `1`、`true`、`yes` 或 `on`：不開啟瀏覽器。 |
| `TAU_PASSWORD_HASH` | `tau hash-password` 輸出的密碼雜湊。啟用登入頁。 |
| `TAU_TRUSTED_HEADER_SHA256` | 受信任的反向代理在 `X-Tau-Auth` 中傳送的密鑰的 SHA-256 摘要（十六進位），見[下文](#在受信任的代理後略過密碼)。 |
| `TAU_PI_BIN` | 用來取代 `PATH` 上那個 `pi` 的執行檔路徑。 |
| `PI_CODING_AGENT_DIR` | pi 的 agent 目錄（預設 `~/.pi/agent`）；tau 讀寫同一個目錄。 |
| `TAU_NAME` | 瀏覽器標題中的顯示名稱。`url`、`host` 或 `domain` 表示取自請求的主機名稱。 |
| `TAU_DISABLE_AUTOUPDATE` | `1`、`true`、`yes` 或 `on`：拒絕伺服器和主機的應用程式內更新。 |
| `TAU_STT_ENDPOINT`、`TAU_STT_KEY`、`TAU_STT_MODEL` | 語音轉寫：端點接收 multipart 的 `file`（和 `model`），`TAU_STT_KEY` 作為 Bearer 權杖傳送。未設定端點時語音輸入關閉。 |
| `TAU_DISCONNECT_DESTROY_MS` | 無人檢視的工作階段程序在多久後停止（預設 2 分鐘，`0` 表示停用）。 |

### 密碼

繫結到 `127.0.0.1` 時，tau 不需要密碼。要監聽其他位址，tau 必須有密碼雜湊，否則拒絕啟動：

```bash
tau hash-password                         # prompts, input hidden
echo "a-long-random-password" | tau hash-password
TAU_PASSWORD_HASH='scrypt$15$8$1$...' tau --hostname 0.0.0.0
```

tau 只接受雜湊。`--password` 參數會被拒絕。明文的 `TAU_PASSWORD` 仍會被偵測到：tau 在啟動時將它雜湊，從自己的環境中刪除它，並在警告中印出應改用的雜湊（與 `TAU_PASSWORD_HASH` 同時設定則會被拒絕）。原因是每個 pi 工作階段都繼承 tau 的環境，代理可能把明文密碼印到對話紀錄中。瀏覽器登入有效期為 30 天。

### 在反向代理之後

在非迴路位址上無 TLS 監聽時，tau 會發出警告。請透過反向代理或 VPN 以 HTTPS 提供服務，並讓 tau 本身繫結到 `127.0.0.1`。代理必須轉送 WebSocket 升級（主機使用 `/api/hosts/link` 和 `/api/hosts/maintenance`）。對於主機以權杖驗證的路徑（`/api/hosts/link`、`/api/hosts/maintenance` 和 `/api/hosts/cluster-config/…`），代理不得再加上自己的驗證。

#### 在受信任的代理後略過密碼

tau 自己看不到用戶端位址，因此可以由反向代理為請求擔保。代理在 `X-Tau-Auth` 標頭中傳送一個密鑰，tau 只在 `TAU_TRUSTED_HEADER_SHA256` 中保存該密鑰的 SHA-256 摘要。標頭雜湊與摘要相符的請求視為已登入。沒有密碼雜湊時，就沒有可略過的東西。

產生一個長的隨機密鑰，且不要把它寫在命令列上。下面的指令把它寫入 nginx 的 include 檔案，只印出摘要：

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

一律設定此標頭，這樣用戶端自己傳送的 `X-Tau-Auth` 會被空值取代。為 tau 的 `server` 區塊設定明確的 `server_name`，並在 `default_server` 區塊中對其他主機名稱 `return 444;`，以免 DNS 重新繫結讓 nginx 把密鑰加到其他網站的請求上。tau 只保存快速的 SHA-256 摘要，這只對長的隨機密鑰安全：不要在這裡重複使用密碼。

## 服務

每個安裝程式都執行兩個服務：Web 伺服器和主機常駐程式（`tau host`）。

### Linux（systemd 使用者服務）

```bash
TAU_PASSWORD_HASH='scrypt$...' tau-systemd install   # or: npx --yes --package=@ompweb-dev/tau@latest tau-systemd install
tau-systemd status
```

`install` 把單元 `tau.service` 和 `tau-host.service` 寫入 `~/.config/systemd/user/`，建立 `~/.pi/agent/web-service.env`（連接埠、主機名稱、密碼雜湊；修改後不必重新安裝），並啟用兩者。其他指令：`uninstall`（`--clean-config` 一併刪除 env 檔案）、`start`、`stop`、`restart`（僅 Web 服務）、`open`。選項：`--port`、`--hostname`、`--no-autostart`、`--json`。記錄：`journalctl --user -u tau -u tau-host -f`。

在 KDE Plasma 等支援 StatusNotifierItem 的桌面上，`tau --install-tray` 會加入一個控制這些 systemd 服務的系統匣圖示。

### macOS（launchd）

```bash
TAU_PASSWORD_HASH='scrypt$...' tau-launchd install   # or: npx -p @ompweb-dev/tau@latest tau-launchd install
tau-launchd status
tau-launchd uninstall
```

`install` 建立 LaunchAgent `dev.ompweb.tau` 和 `dev.ompweb.tau-host`，它們在登入時啟動，當機後重新啟動。它從執行時的環境讀取 `PORT`、`TAU_HOSTNAME`、`TAU_PASSWORD_HASH`、`TAU_TRUSTED_HEADER_SHA256`、`TAU_PI_BIN`、`TAU_NAME`、`TAU_DISABLE_AUTOUPDATE` 和 `PI_CODING_AGENT_DIR`。記錄寫入 `~/Library/Logs/tau`。

### Windows（系統匣和背景服務）

```powershell
tau --install-tray
```

這會安裝背景服務、主機常駐程式（排程工作 `tau-host`）、系統匣圖示、登入時自動啟動以及桌面和開始功能表捷徑。以 `tau-tray status|start|stop|restart|open|uninstall` 管理。服務從 `%USERPROFILE%\.pi\agent\web-service.json` 讀取設定，從使用者或系統環境變數讀取 `TAU_PASSWORD_HASH`。

### 把單一執行檔作為服務

自行撰寫兩個單元。以 systemd 為例（依需要調整路徑）：

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

`PATH` 必須包含 `pi` 所在目錄（以及 pi 使用的 Node.js 的目錄）。在 macOS 上，兩個以 `RunAtLoad` 和 `KeepAlive` 執行 `…/tau --no-open` 與 `…/tau host` 的 launchd agent 可達到相同效果；在 Windows 上，則是兩個在登入時執行 `tau.exe --no-open` 與 `tau.exe host` 的工作排程器工作。

## 主機與叢集

### 主機常駐程式

`tau host` 是在一台機器上執行 pi 工作階段並讀取其工作階段檔案的程序。它透過 WebSocket 主動連線到一台或多台 tau 伺服器，因此可以位於 NAT 之後。連結或 Web 伺服器中斷時工作階段繼續執行，連結恢復後伺服器重新加入這些工作階段。在伺服器自己的機器上，常駐程式會自動連結（**Settings → Hosts** 中的「This machine」）。

```text
tau host login [--add] --url <server url>   save a link; the host token is read from stdin
tau host logout --url <server url>          remove a link
tau host [--allow-http]                     run the daemon
tau host status|drain|resume                control the running daemon
```

常駐程式只接受 `https://` 伺服器網址，`http://` 僅限迴路位址。`--allow-http` 允許對其他位址使用明文 HTTP；此時主機權杖以未加密方式傳輸，只應在受信任的網路中使用。

### 連結另一台機器

另一台機器需要 pi，以及 npm 版 tau（Node.js 24）或單一執行檔。

1. 在 tau 伺服器上開啟 **Settings → Hosts → Add host**，輸入名稱並複製權杖。權杖只顯示一次；伺服器只保存其雜湊。
2. 在另一台機器上儲存連結。依提示貼上權杖，或透過管線傳入；它不會出現在 `ps` 中：

   ```bash
   npx @ompweb-dev/tau@latest host login --url https://tau.example.com
   ```

   連結以 `600` 權限儲存到 `~/.pi/agent/tau/host.json`。`--add` 會新增到另一台伺服器的連結，而不是取代第一個。
3. 執行常駐程式並讓它持續執行（作為服務執行，見[服務](#服務)）：

   ```bash
   npx @ompweb-dev/tau@latest host
   ```

之後該主機顯示為上線，側邊欄為它的工作區分組，新增工作階段畫面也可以選擇它。每台主機保留自己的 `~/.pi/agent`、工作階段和供應商登入。**Settings → Hosts** 還可以重新命名和撤銷主機、顯示每台主機的 tau 版本並提供更新，以及設定代理能否不經詢問就在該主機上啟動工作階段。被撤銷主機的常駐程式會停止它的工作階段。

### 叢集

在 **Settings → Hosts** 中可以把已連結的主機加入叢集；本機是主節點（master），隨第一台主機一起加入。加入的主機必須上線，並提供一個用於叢集簽出的專案資料夾。它的 Git 專案依儲存庫 origin 繫結到叢集專案。之後叢集工作階段可以在任一成員上啟動。

成員使用主節點的 pi 設定執行工作階段。主節點建立一份帶版本的清單，包括：

- 來自其 pi agent 目錄：`settings.json`、`models.json`、`mcp.json`、`AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`，以及目錄 `skills/`、`prompts/`、`themes/` 和 `extensions/`；
- `~/.agents/skills/`；
- **Settings → System** 中的代理環境變數。

每個成員的常駐程式下載缺少的檔案，驗證其雜湊，並整體套用該版本，要麼全部套用，要麼完全不套用。主節點每 30 秒檢查一次，在成員上啟動工作階段時會先套用目前版本。被鏡像的目錄會變得與主節點的完全相同（排除 `node_modules` 和 `.git`）。限制：單一檔案 5 MiB，總計 50 MiB。

不鏡像的內容：憑證（`auth.json`、`mcp-auth.json`）、工作階段、快取、儲存庫內的設定，以及程式（MCP 伺服器的指令，或 `settings.json` 指定的套件，後者由 pi 在成員上自行安裝）。成員對 `settings.json` 中的以下鍵保留自己的值：`shellPath`、`shellCommandPrefix`、`npmCommand`、`selfUpdateCommand`、`externalEditor`、`sessionDir`、`httpProxy`、`extensions`、`skills`、`prompts`、`themes`、`deviceId`、`trackingId`、`lastChangelogVersion`、`extensionChangelogVersions` 和 `terminal`。

首次套用時，成員自己的設定會移到 `~/.pi/agent/tau/own-config/`；離開叢集時再放回去。一台主機同一時間只持有一台伺服器的設定。供應商登入永遠不會被鏡像：請在每個成員上分別登入（見下文）。

## 設定

tau 使用 pi 自己的檔案，並增加幾個自己的檔案：

| 路徑 | 內容 |
| --- | --- |
| `~/.pi/agent/settings.json` | pi 設定；**Settings** 可編輯預設思考層級、思考區塊顯示、啟用的模型、重試和壓縮（compaction）。 |
| `~/.pi/agent/models.json` | 自訂供應商和模型；在 **Settings → API Keys & Providers** 中編輯。 |
| `~/.pi/agent/auth.json` | pi 的供應商登入和 API 金鑰，由 pi 寫入。 |
| `~/.pi/agent/sessions/` | pi 工作階段檔案，tau 列出並讀取它們。 |
| `~/.pi/agent/tau-settings.json` | tau 伺服器設定：重新啟動後自動恢復、代理工具、GitHub 寫入和 Actions 權限、代理環境變數、上傳保留期限。 |
| `~/.pi/agent/projects.json` | 加入側邊欄或從側邊欄隱藏的工作區。 |
| `~/.pi/agent/tau/` | tau 狀態：主機登錄表（`hosts.json`）、常駐程式的連結（`host.json`）、叢集（`pools.json`）、登入簽章金鑰、通知、訊息寄件匣、上傳。 |
| `~/.pi/agent/web-service.env` | `tau-systemd` 寫入的服務設定（Windows 上為 `web-service.json`）。 |

所有路徑都遵循 `PI_CODING_AGENT_DIR`。

**供應商登入依主機分別保存。** tau 自己從不讀取 `auth.json`。登入（OAuth 和 API 金鑰）在所選主機的常駐程式上、透過 tau 的隨附擴充功能（`lib/pi/tau-extension.ts` 中的 `/tau_auth` 指令）在 pi 內部完成；原始金鑰和權杖留在該主機的 pi 中。要在某台主機上登入，請在 **Settings → API Keys & Providers** 中選擇該主機。

**代理環境變數**（**Settings → System**）會加到之後啟動的每個 pi 程序中。會改變 pi 狀態位置或 tau 內部機制的名稱會被拒絕：`PATH`、`PATHEXT`、`COMSPEC`、`SYSTEMROOT`、`WINDIR`、`NODE_OPTIONS`、`HOME`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME`、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、`PORT`、`NODE_ENV`，以及所有以 `TAU_` 或 `_` 開頭的名稱。

## 安全性說明

- **代理以你的使用者權限執行。** pi 的工具可以讀寫你的使用者能存取的任何檔案並執行指令。tau 不對其做沙箱隔離。任何能登入 tau 的人，都能讓代理在每台已連結的主機上這麼做。
- **密碼閘門。** 設定 `TAU_PASSWORD_HASH` 後，除登入頁、靜態資源、Service Worker 和主機驗證的路徑外，所有頁面和 API 路由都需要工作階段 Cookie（或受信任代理的標頭）。沒有密碼雜湊時，tau 拒絕監聽非迴路位址。
- **HTTPS。** tau 使用明文 HTTP。任何遠端存取都應放在 HTTPS（反向代理或 VPN）之後，以保護密碼、工作階段 Cookie 和主機權杖。Web Push 通知也需要 HTTPS。
- **密鑰不會進入工作階段。** `TAU_PASSWORD`、`TAU_PASSWORD_HASH`、`TAU_TRUSTED_HEADER_SECRET`、`TAU_TRUSTED_HEADER_SHA256`、`TAU_STT_KEY`、`PORT` 和 `NODE_ENV` 會從每個 pi 程序和專案指令的環境中移除。
- **主機權杖。** 伺服器只保存每個主機權杖的 SHA-256。主機常駐程式從標準輸入讀取權杖，並保存在權限為 `600` 的檔案中。被撤銷的權杖會立即被拒絕。
- **瀏覽器中的檔案存取。** 檔案檢視器和檔案總管只提供允許的根目錄：你加入或開啟過的工作區、工作階段的工作目錄和經過驗證的 worktree，以及工作階段對話紀錄引用的檔案（唯讀）。即使在允許的根目錄內，pi 目錄中已知的憑證檔案（`models.json`、`.env` 檔案）也會被拒絕。這些限制針對瀏覽器，不針對代理。
- **代理工具預設關閉。** 啟用後，任何工作階段都可以列出工作階段、啟動工作階段或傳送訊息給另一個工作階段，並使用伺服器 `gh` 登入的 GitHub 工具。除非開啟 **Allow agent GitHub writes without asking**，留言和討論串寫入會在工作階段中詢問；Actions 的 dispatch、cancel 和 rerun 預設各自詢問。在某台主機上啟動工作階段時，除非該主機允許代理啟動，否則會詢問。

## 開發

```bash
npm install
npm run dev            # Bun hot reload at http://127.0.0.1:30188
npm run build          # bundle the browser app into dist/
npm start              # serve dist/ at http://127.0.0.1:30187
npm run build:binary   # single binary for this machine into release/ (-- --target bun-linux-arm64 for another)
npm run typecheck && npm run lint && npm test
```

開發伺服器不會接管主機常駐程式：開發時「This machine」顯示為離線，常駐程式仍連結到你已安裝的 tau。

## 授權

MIT，見 [LICENSE](./LICENSE)。tau 衍生自 [ompweb](https://github.com/ompweb-dev/ompweb)，而 ompweb 衍生自 [agegr/pi-web](https://github.com/agegr/pi-web)。
