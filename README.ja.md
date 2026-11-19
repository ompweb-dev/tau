<div align="center">

<img src="public/icon.svg" alt="tau logo" width="150">

<h1>tau</h1>

</div>

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

tau は [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) のためのブラウザワークスペースです。
pi のセッションを読み込み、コンパニオンの pi 拡張とともに `pi --mode rpc` でライブセッションを実行します。どのブラウザからでもエージェントとのチャット、プロジェクトとファイルの閲覧、pi の設定管理ができます。1 台の tau サーバーから、リンクした別のマシン上でセッションを実行することもできます。

## 機能

- **チャット**: ストリーミング応答、ライブ出力付きのツール呼び出し、思考ブロック、フォローアップのキューとステアリング、停止、`ask` ツールの質問のダイアログ表示。
- **セッション**: プロジェクトごとの過去セッションの閲覧、セッションのフォーク、セッション内ブランチの切り替え、過去メッセージの編集、アーカイブと復元、タイトルとトランスクリプトの検索。
- **中断に強いメッセージ**: 既存セッションへのメッセージは、pi が受け付けるまでブラウザとサーバーに保持され、再接続や再起動をまたいで届きます。
- **ファイルと Git**: チャットの横のファイルエクスプローラーとプレビュー、セッションへのアップロード、Git worktree。
- **サブエージェント**: pi に `pi-subagents` パッケージが入っている場合、その実行の進捗とトランスクリプト。
- **リモートホストとクラスター**: リンクしたマシンでセッションを実行。マシンをクラスターにまとめ、プロジェクトとこのサーバーの pi 設定を共有。
- **通知**: 実行の完了、質問、失敗をページ内、デスクトップ、Web Push（HTTPS 経由）で通知。
- **エージェントツール**（既定でオフ）: セッション横断ツールと、サーバーの `gh` ログインを使う GitHub ツール。
- **音声入力**: 設定したエンドポイントによる任意の文字起こし。

## 動作要件

- npm パッケージには **Node.js 24 以降**。ランチャー（`tau`）は Node で動き、サーバーは [Bun](https://bun.sh) 1.4.4 以降で動きます。Bun はパッケージの依存としてインストールされます（同梱の Bun がない場合は、`PATH` 上のそのバージョン以上の `bun` を使います）。[単一バイナリ](#単一バイナリ)はどちらも不要です。
- セッションを実行するすべてのマシンに **pi** をインストールします:

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

  tau は `PATH` 上の `pi` を実行します。別の pi を使うには `TAU_PI_BIN` にそのパスを設定します。tau は pi 1.5.2 を対象に開発されています。pi がなくても過去セッションの閲覧はできますが、セッションは開始できません。

## インストール

### npm または Bun

```bash
npm install -g @ompweb-dev/tau
tau
```

`bun add -g @ompweb-dev/tau` でも同じパッケージをインストールできますが、`tau` ランチャーには `PATH` 上の Node.js 24 が必要です。`npx @ompweb-dev/tau@latest` ならグローバルインストールなしで実行できます。

tau はブラウザで `http://127.0.0.1:30187` を開きます。**Settings → API Keys & Providers** でモデルプロバイダーにログインし（[設定](#設定)を参照）、ワークスペースを選んでセッションを開始します。

### 単一バイナリ

各リリースには、tau を 1 つのコンパイル済みプログラムにし、配信するファイルを横に置いたものも含まれます:
`tau-linux-x64.tar.gz`、`tau-linux-arm64.tar.gz`、`tau-darwin-x64.tar.gz`、`tau-darwin-arm64.tar.gz`、`tau-windows-x64.zip`。Node.js、npm、Bun は不要です。pi は同梱されておらず、`PATH` 上の `pi`（または `TAU_PI_BIN`）を実行します。CI を通過した `main` の各コミットも、同じアーカイブ付きのプレリリースとして公開されます。

```bash
tar -xzf tau-linux-x64.tar.gz -C ~/.local/share   # unpacks tau-linux-x64/
~/.local/share/tau-linux-x64/tau                   # same options and environment variables as the npm launcher
```

- `tau` はそのディレクトリに置いたままにしてください。`dist/`、`public/`、pi 拡張をそこから配信します（`PATH` 上のシンボリックリンクは可）。`TAU_PACKAGE_DIR` が設定されていればそこから配信します。
- バイナリには `tau host` と `tau hash-password` がありますが、トレイとサービスインストーラーはありません。サービスのユニットは[サービス](#サービス)の例のように自分で書きます。
- macOS はダウンロードを隔離します。初回起動前に `xattr -dr com.apple.quarantine tau-darwin-arm64` を一度実行してください。
- macOS 15 以降は、アプリがローカルネットワークに接続する前に確認を求めます。`curl` では届くのに `tau host` が LAN 上のサーバーに対して `ECONNREFUSED` を報告する場合は、システム設定 → プライバシーとセキュリティ → ローカルネットワークでターミナル（または `tau`）を許可してください。

### ソースから

```bash
git clone https://github.com/ompweb-dev/tau.git
cd tau
npm install
npm run build
node bin/tau.js
```

## 実行

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

本番サーバーは、このマシンのホストデーモン（`tau host`）が動いていなければ起動します。ローカルのものを含むすべてのセッションはこのデーモンの下で動くため、Web サーバーを再起動しても実行中のセッションは止まりません。

### 環境変数

| 変数 | 意味 |
| --- | --- |
| `PORT` | サーバーのポート（既定 `30187`）。 |
| `TAU_HOSTNAME` | バインドするアドレス（既定 `127.0.0.1`）。 |
| `TAU_NO_OPEN` | `1`、`true`、`yes`、`on`: ブラウザを開かない。 |
| `TAU_PASSWORD_HASH` | `tau hash-password` が出力するパスワードハッシュ。サインインページを有効にします。 |
| `TAU_TRUSTED_HEADER_SHA256` | 信頼できるリバースプロキシが `X-Tau-Auth` で送るシークレットの SHA-256 ダイジェスト（16 進）。[下記](#信頼できるプロキシでのパスワード省略)を参照。 |
| `TAU_PI_BIN` | `PATH` 上のものの代わりに実行する `pi` のパス。 |
| `PI_CODING_AGENT_DIR` | pi のエージェントディレクトリ（既定 `~/.pi/agent`）。tau も同じものを読み書きします。 |
| `TAU_NAME` | ブラウザのタイトルに出す表示名。`url`、`host`、`domain` ならリクエストのホスト名から作ります。 |
| `TAU_DISABLE_AUTOUPDATE` | `1`、`true`、`yes`、`on`: サーバーとホストのアプリ内更新を拒否します。 |
| `TAU_STT_ENDPOINT`、`TAU_STT_KEY`、`TAU_STT_MODEL` | 音声の文字起こし。エンドポイントはマルチパートの `file`（と `model`）を受け取り、`TAU_STT_KEY` は Bearer トークンとして送られます。エンドポイントがなければ音声入力はオフです。 |
| `TAU_DISCONNECT_DESTROY_MS` | 誰も見ていないセッションプロセスを停止するまでの時間（既定 2 分、`0` で無効）。 |

### パスワード

`127.0.0.1` にバインドしている間、tau はパスワードを必要としません。それ以外のアドレスで待ち受けるにはパスワードハッシュが必須で、ないと起動を拒否します:

```bash
tau hash-password                         # prompts, input hidden
echo "a-long-random-password" | tau hash-password
TAU_PASSWORD_HASH='scrypt$15$8$1$...' tau --hostname 0.0.0.0
```

tau が受け付けるのはハッシュだけです。`--password` フラグは拒否されます。平文の `TAU_PASSWORD` は検出されます。tau は起動時にそれをハッシュ化して自分の環境から削除し、代わりに使うハッシュを警告に表示します（`TAU_PASSWORD_HASH` と同時に設定すると拒否されます）。理由は、すべての pi セッションが tau の環境を引き継ぐため、エージェントが平文のパスワードをトランスクリプトに出力しうるからです。ブラウザのサインインは 30 日間有効です。

### リバースプロキシの背後で

TLS なしで非ループバックアドレスを待ち受けると、tau は警告を出します。リバースプロキシまたは VPN を通して HTTPS で配信し、tau 自体は `127.0.0.1` にバインドしてください。プロキシは WebSocket のアップグレードを通す必要があります（ブラウザは `/api/events/link`、ホストは `/api/hosts/link` と `/api/hosts/maintenance` を使います）。ホストがトークンで認証するパス（`/api/hosts/link`、`/api/hosts/maintenance`、`/api/hosts/cluster-config/…`）には、プロキシ独自の認証を加えないでください。

#### 信頼できるプロキシでのパスワード省略

tau 自身はクライアントのアドレスを見られないため、リバースプロキシにリクエストを保証させることができます。プロキシは `X-Tau-Auth` ヘッダーでシークレットを送り、tau はそのシークレットの SHA-256 ダイジェストだけを `TAU_TRUSTED_HEADER_SHA256` に持ちます。ヘッダーのハッシュがダイジェストと一致するリクエストはサインイン済みとして扱われます。パスワードハッシュがなければ、省略するものはありません。

長いランダムなシークレットを、コマンドラインに書かずに生成します。次の例はシークレットを nginx のインクルードファイルに書き込み、ダイジェストだけを表示します:

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

ヘッダーは常に設定してください。そうすれば、クライアント自身が送る `X-Tau-Auth` は空の値で置き換えられます。tau の `server` ブロックには明示的な `server_name` を付け、他のホスト名には `default_server` ブロックで `return 444;` を返してください。そうしないと、DNS リバインディングで nginx が他サイトのリクエストにシークレットを付けてしまいます。tau が保存するのは高速な SHA-256 ダイジェストだけで、これが安全なのは長いランダムなシークレットの場合に限られます。パスワードを流用しないでください。

## サービス

どのインストーラーも 2 つのサービスを動かします: Web サーバーとホストデーモン（`tau host`）です。

### Linux（systemd ユーザーサービス）

```bash
TAU_PASSWORD_HASH='scrypt$...' tau-systemd install   # or: npx --yes --package=@ompweb-dev/tau@latest tau-systemd install
tau-systemd status
```

`install` はユニット `tau.service` と `tau-host.service` を `~/.config/systemd/user/` に書き、`~/.pi/agent/web-service.env`（ポート、ホスト名、パスワードハッシュ。再インストールなしで編集可）を作成し、両方を有効にします。その他のコマンド: `uninstall`（`--clean-config` で env ファイルも削除）、`start`、`stop`、`restart`（Web サービスのみ）、`open`。オプション: `--port`、`--hostname`、`--no-autostart`、`--json`。ログ: `journalctl --user -u tau -u tau-host -f`。

KDE Plasma など StatusNotifierItem 対応のデスクトップでは、`tau --install-tray` でこれらの systemd サービスを操作するトレイアイコンを追加できます。

### macOS（launchd）

```bash
TAU_PASSWORD_HASH='scrypt$...' tau-launchd install   # or: npx -p @ompweb-dev/tau@latest tau-launchd install
tau-launchd status
tau-launchd uninstall
```

`install` は LaunchAgent `dev.ompweb.tau` と `dev.ompweb.tau-host` を作成します。どちらもログイン時に起動し、クラッシュ時に再起動します。実行時の環境から `PORT`、`TAU_HOSTNAME`、`TAU_PASSWORD_HASH`、`TAU_TRUSTED_HEADER_SHA256`、`TAU_PI_BIN`、`TAU_NAME`、`TAU_DISABLE_AUTOUPDATE`、`PI_CODING_AGENT_DIR` を読み取ります。ログは `~/Library/Logs/tau` に出力されます。

### Windows（トレイとバックグラウンドサービス）

```powershell
tau --install-tray
```

バックグラウンドサービス、ホストデーモン（スケジュールされたタスク `tau-host`）、トレイアイコン、ログオン時の自動起動、デスクトップとスタートメニューのショートカットをインストールします。管理は `tau-tray status|start|stop|restart|open|uninstall` で行います。サービスは設定を `%USERPROFILE%\.pi\agent\web-service.json` から、`TAU_PASSWORD_HASH` をユーザーまたはシステムの環境変数から読み取ります。

### 単一バイナリをサービスとして

2 つのユニットを自分で書きます。systemd の例（パスは適宜変更）:

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

`PATH` には `pi` のディレクトリ（と pi が動く Node.js のディレクトリ）を含める必要があります。macOS では `…/tau --no-open` と `…/tau host` を `RunAtLoad` と `KeepAlive` 付きで実行する 2 つの launchd エージェント、Windows ではログオン時に `tau.exe --no-open` と `tau.exe host` を実行する 2 つのタスクスケジューラのタスクで同じことができます。

## ホストとクラスター

### ホストデーモン

`tau host` は、マシン上で pi セッションを実行し、そのセッションファイルを読むプロセスです。1 つ以上の tau サーバーへ WebSocket で外向きに接続するため、NAT の内側にあっても動きます。リンクや Web サーバーが落ちてもセッションは動き続け、リンクが戻るとサーバーが再びセッションに参加します。サーバー自身のマシンでは、デーモンは自動的にリンクされます（**Settings → Hosts** の「This machine」）。

```text
tau host login [--add] --url <server url>   save a link; the host token is read from stdin
tau host logout --url <server url>          remove a link
tau host [--allow-http]                     run the daemon
tau host status|drain|resume                control the running daemon
```

デーモンが受け付けるサーバー URL は `https://` のみで、`http://` はループバックアドレスに限られます。`--allow-http` は他のアドレスへの平文 HTTP を許可します。ホストトークンが暗号化されずに流れるため、信頼できるネットワークでのみ使ってください。

### 別のマシンをリンクする

別のマシンには pi と、npm 版の tau（Node.js 24）または単一バイナリが必要です。

1. tau サーバーで **Settings → Hosts → Add host** を開き、名前を入力してトークンをコピーします。トークンは一度だけ表示され、サーバーはそのハッシュだけを保存します。
2. 別のマシンでリンクを保存します。求められたらトークンを貼り付けるか、パイプで渡します。`ps` に表示されることはありません:

   ```bash
   npx @ompweb-dev/tau@latest host login --url https://tau.example.com
   ```

   リンクはモード `600` で `~/.pi/agent/tau/host.json` に保存されます。`--add` を付けると、最初のリンクを置き換えずに別のサーバーへのリンクを追加します。
3. デーモンを起動し、動かし続けます（サービスとして。[サービス](#サービス)を参照）:

   ```bash
   npx @ompweb-dev/tau@latest host
   ```

するとホストがオンラインと表示され、サイドバーにそのワークスペースのグループができ、新規セッション画面で選べるようになります。各ホストは自分の `~/.pi/agent`、セッション、プロバイダーのログインを持ちます。**Settings → Hosts** ではホストの名前変更と取り消し、各ホストの tau バージョンと更新の表示、エージェントが確認なしでそこでセッションを開始できるかどうかの設定もできます。取り消されたホストのデーモンは自分のセッションを停止します。

### クラスター

**Settings → Hosts** では、リンク済みのホストをクラスターに追加できます。このマシンがマスターで、最初のホストと一緒に参加します。参加するホストはオンラインである必要があり、クラスターのチェックアウト用にプロジェクトフォルダーを指定します。そのホストの Git プロジェクトは、リポジトリの origin によってクラスターのプロジェクトに結び付けられます。以後、クラスターのセッションはどのメンバーでも開始できます。

メンバーはマスターの pi 設定でセッションを実行します。マスターは次のもののバージョン付きマニフェストを作ります:

- pi エージェントディレクトリから: `settings.json`、`models.json`、`mcp.json`、`AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、およびディレクトリ `skills/`、`prompts/`、`themes/`、`extensions/`
- `~/.agents/skills/`
- **Settings → System** のエージェント環境変数

各メンバーのデーモンは不足しているファイルをダウンロードしてハッシュを確認し、バージョンを丸ごと適用するか、まったく適用しないかのどちらかです。マスターは 30 秒ごとに確認し、メンバーでのセッション開始時には先に現在のバージョンを適用します。ミラーされたディレクトリはマスターのものと同一になります（`node_modules` と `.git` は除外）。上限: 1 ファイル 5 MiB、合計 50 MiB。

ミラーされないもの: 認証情報（`auth.json`、`mcp-auth.json`）、セッション、キャッシュ、リポジトリ内の設定、そしてプログラム（MCP サーバーのコマンドや、`settings.json` が指定するパッケージ。後者は pi がメンバー上で自らインストールします）。メンバーは `settings.json` の次のキーについて自分の値を保ちます: `shellPath`、`shellCommandPrefix`、`npmCommand`、`selfUpdateCommand`、`externalEditor`、`sessionDir`、`httpProxy`、`extensions`、`skills`、`prompts`、`themes`、`deviceId`、`trackingId`、`lastChangelogVersion`、`extensionChangelogVersions`、`terminal`。

最初の適用時に、メンバー自身の設定は `~/.pi/agent/tau/own-config/` に移され、クラスターを離れると元に戻ります。1 台のホストが保持できるのは一度に 1 つのサーバーの設定だけです。プロバイダーのログインはミラーされないため、各メンバーでログインしてください（下記参照）。

## 設定

tau は pi 自身のファイルを使い、いくつか独自のファイルを加えます:

| パス | 内容 |
| --- | --- |
| `~/.pi/agent/settings.json` | pi の設定。**Settings** では既定の思考レベル、思考ブロックの表示、有効なモデル、リトライ、コンパクションを編集します。 |
| `~/.pi/agent/models.json` | カスタムのプロバイダーとモデル。**Settings → API Keys & Providers** で編集します。 |
| `~/.pi/agent/auth.json` | pi のプロバイダーログインと API キー。pi が書き込みます。 |
| `~/.pi/agent/sessions/` | pi のセッションファイル。tau が一覧表示して読み込みます。 |
| `~/.pi/agent/tau-settings.json` | tau サーバーの設定: 再起動後の自動再開、エージェントツール、GitHub の書き込みと Actions の権限、エージェント環境変数、アップロードの保持期間。 |
| `~/.pi/agent/projects.json` | サイドバーに追加した、または非表示にしたワークスペース。 |
| `~/.pi/agent/tau/` | tau の状態: ホスト登録（`hosts.json`）、デーモンのリンク（`host.json`）、クラスター（`pools.json`）、サインイン鍵、通知、メッセージのアウトボックス、アップロード。 |
| `~/.pi/agent/web-service.env` | `tau-systemd` が書くサービス設定（Windows では `web-service.json`）。 |

すべてのパスは `PI_CODING_AGENT_DIR` に従います。

**プロバイダーのログインはホストごとです。** tau 自身は `auth.json` を読みません。ログイン（OAuth と API キー）は、選択したホストのデーモン上で、tau のコンパニオン拡張（`lib/pi/tau-extension.ts` の `/tau_auth` コマンド）を通して pi の中で行われます。生のキーやトークンはそのホストの pi にとどまります。そのホストでログインするには、**Settings → API Keys & Providers** でホストを選んでください。

**エージェント環境変数**（**Settings → System**）は、保存後に起動するすべての pi プロセスに追加されます。pi の状態や tau の内部を変えてしまう名前は拒否されます: `PATH`、`PATHEXT`、`COMSPEC`、`SYSTEMROOT`、`WINDIR`、`NODE_OPTIONS`、`HOME`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME`、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、`PORT`、`NODE_ENV`、および `TAU_` または `_` で始まるすべての名前。

## セキュリティに関する注意

- **エージェントはあなたのユーザー権限で動きます。** pi のツールは、あなたのユーザーが扱えるあらゆるファイルを読み書きし、コマンドを実行できます。tau はサンドボックス化しません。tau にサインインできる人は誰でも、リンクされたすべてのホストでエージェントにそれをさせられます。
- **パスワードゲート。** `TAU_PASSWORD_HASH` を設定すると、サインインページ、静的アセット、Service Worker、ホストが認証するパスを除くすべてのページと API ルートで、セッション Cookie（または信頼できるプロキシのヘッダー）が必要になります。パスワードハッシュなしで非ループバックアドレスを待ち受けることを tau は拒否します。
- **HTTPS。** tau は平文の HTTP を話します。リモートからアクセスする場合は HTTPS（リバースプロキシまたは VPN）の背後に置き、パスワード、セッション Cookie、ホストトークンを保護してください。Web Push 通知にも HTTPS が必要です。
- **シークレットはセッションに渡りません。** `TAU_PASSWORD`、`TAU_PASSWORD_HASH`、`TAU_TRUSTED_HEADER_SECRET`、`TAU_TRUSTED_HEADER_SHA256`、`TAU_STT_KEY`、`PORT`、`NODE_ENV` は、すべての pi プロセスとプロジェクトコマンドの環境から削除されます。
- **ホストトークン。** サーバーは各ホストトークンの SHA-256 だけを保存します。ホストのデーモンはトークンを標準入力から読み、モード `600` のファイルに保存します。取り消されたトークンは即座に拒否されます。
- **ブラウザからのファイルアクセス。** ファイルビューアーとエクスプローラーが配信するのは許可されたルートだけです: 追加または開いたワークスペース、セッションの作業ディレクトリと検証済みの worktree、そしてセッションのトランスクリプトが参照するファイル（読み取りのみ）。pi ディレクトリ内の既知の認証情報ファイル（`models.json`、`.env` ファイル）は、許可されたルート内でも拒否されます。これらの制限はブラウザに対するもので、エージェントには適用されません。
- **エージェントツールは既定でオフです。** 有効にすると、どのセッションもセッションの一覧表示、セッションの開始、別のセッションへのメッセージ送信ができ、サーバーの `gh` ログインで GitHub ツールを使えます。コメントとスレッドへの書き込みは、**Allow agent GitHub writes without asking** がオンでない限りセッション内で確認され、Actions の dispatch、cancel、rerun はそれぞれ既定で確認されます。ホストでのセッション開始は、そのホストがエージェントによる開始を許可していない限り確認されます。

## 開発

```bash
npm install
npm run dev            # Bun hot reload at http://127.0.0.1:30188
npm run build          # bundle the browser app into dist/
npm start              # serve dist/ at http://127.0.0.1:30187
npm run build:binary   # single binary for this machine into release/ (-- --target bun-linux-arm64 for another)
npm run typecheck && npm run lint && npm test
```

開発サーバーはホストデーモンを引き継ぎません。開発中は「This machine」がオフラインと表示され、デーモンはインストール済みの tau にリンクされたままです。

## ライセンス

MIT。[LICENSE](./LICENSE) を参照してください。tau は [ompweb](https://github.com/ompweb-dev/ompweb) からフォークされ、ompweb は [agegr/pi-web](https://github.com/agegr/pi-web) からフォークされました。
