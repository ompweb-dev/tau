# Contributing to tau

Thanks for your interest in contributing!

tau is a web UI for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Read
`AGENTS.md` (development notes) and `DESIGN.md` (the porting contract) before larger changes.

## Setup

- Node.js 24 or newer. The server runs on [Bun](https://bun.sh), which `npm install` provides (the `bun` npm package).
- pi, for live sessions: `npm i -g @earendil-works/pi-coding-agent` (tau is developed against pi 1.5.2).

```bash
npm install
npm run dev   # http://127.0.0.1:30188, Bun hot reload (npm run dev:lan listens on 0.0.0.0)
```

tau finds pi through `TAU_PI_BIN` (a pi binary or a wrapper script), else `pi` on `PATH`. Without pi, session
browsing still works, the host reports `pi-missing` and live commands fail with `pi_not_found`. Tests that need a
real pi skip themselves when none is found.

The dev server leaves this machine's host daemon to the production server, so "This machine" shows offline in dev.
See "Local daemon" in `AGENTS.md`.

## Checks (must pass before submitting)

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint, no errors
npm test            # bun test --parallel over app bin components hooks lib scripts server tests
```

Run a subset with `bun test --parallel <files>`. `--parallel` is required even for a few files: each file gets a
fresh module registry, and the test fixtures rely on that.

`npm run build` bundles the browser app into `dist/`; the dev server never reads `dist/`. `npm run smoke` starts
the built server and its local host and checks them (`-- --package <dir>`, `-- --binary <path>`, `-- --pi <path>`).
`npm run build:binary` compiles a standalone release into `release/tau-<os>-<arch>/`. `npm run release:check` runs
typecheck, lint, tests, build and smoke in one go.

### Tests

Tests use `bun test` with `node:test`-style `test()` calls; no Jest or Vitest configuration is required.
Mock a Node builtin with `mockBuiltin` (`tests/mock-builtin.mjs`, built on `mock.module`) and import the module under
test afterwards with a fresh `?fresh=N` query. A test that touches pi's files sets `PI_CODING_AGENT_DIR` to a
private temporary directory before it imports the modules under test.

For interactive components and hooks, import `tests/setup-dom.mjs` before `@testing-library/react/pure.js` (both
imported dynamically, in that order), and register `cleanup` with `afterEach`. Use DOM queries and
`@testing-library/user-event` for component interactions, and `renderHook` for hook state and lifecycle tests. Keep
the real jsdom `window` and `document`; mock only the browser or network APIs a scenario needs.

Static HTML tests can continue using `react-dom/server`. Layout, scrolling and native browser navigation still
require real-browser verification. The jsdom dependency stays on 29.x for now; moving to a newer major is a
separate change.

## Architecture rules

- **No pi packages in tau's code.** The server and the host daemon never import pi's SDK or any `@earendil-works/*`
  package. Every live session is a `pi --mode rpc` child that the session's host daemon spawns, and tau speaks pi's
  RPC (JSON lines on stdio) through `RpcProcess` (`lib/pi/rpc-process.ts`). Session browsing parses pi's `.jsonl`
  files directly (`lib/session-reader.ts`, `lib/pi/session-files.ts`).
- **The companion extension.** What pi's RPC lacks (host tools, the ask dialog, message identity, `/btw`, history
  Edit, provider logins) lives in `lib/pi/tau-extension.ts`, which pi loads with `--extension`. It runs inside pi,
  never in tau's server, and declares the pi types it uses locally. tau calls it with `/tau_<name>` prompt commands
  and it answers through `setWidget("tau", ...)` frames; see "pi's RPC and what tau adds" in `AGENTS.md`.
- **Every session runs through a host daemon**, this machine's included: the web server never spawns a session pi
  (the one exception is the idle-killed utility pi in `lib/pi/rpc-utility.ts`). File and Git operations go through
  `Host.workspaceOps` and run on the daemon that owns the files.
- **The daemon runs on Node.** `bin/tau-host.js` loads `lib/hosts/host-cli.ts` through `jiti`: modules the daemon
  loads use relative imports (no `@/` alias) and no Bun APIs. The server (`server/`) runs on Bun.
- **Browser code** must not import `next/*` (use `lib/dynamic.tsx` and `lib/navigation.ts`) and must not call
  `AbortSignal.timeout`, `AbortSignal.any` or `Promise.withResolvers`.
- **New API routes** are registered in `server/routes.ts` (see "Adding an API route" in `AGENTS.md`).

## Conventions

- **Styling**: use the design tokens in `app/globals.css` (colors, radius, shadow, motion), no hardcoded colors.
  Shared primitives live in `components/ui/` (Dialog/Tooltip/Collapsible/field/toast, built on Base UI); icons come
  from `lucide-react`.
- **i18n**: every user-facing string needs entries in all four dictionaries:
  `lib/i18n/locales/{en,zh-CN,zh-TW,ja}.json`. An API error with a stable `code` is shown through `errors.<code>`.

## Pull requests

- Keep PRs focused; describe the user-visible change and how you verified it.
- For UI changes, include before/after screenshots in both light and dark themes when practical.

## Reporting issues

Please use the issue templates and include your OS, Node version, tau version, pi version (`pi --version`) and
browser.
