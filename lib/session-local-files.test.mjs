// A session's own `local/` directory (composer uploads): read, downloaded and watched through the one file gate
// (GET /api/files, the file channel) by absolute path, under the session's own id. These drive the real route handlers
// over a link to the real daemon workspace service; sessions are real JSONL files the daemon's own list and path cache
// know. The host-ownership proof over a separate Node daemon process is lib/hosts/session-local-files.integration.test.mjs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { linkLocalDaemon } from "./hosts/link-driver.test-helper.mjs";

/** A directory link that needs no privilege on Windows, as in lib/file-access.test.mjs. */
const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

const hub = await import("./hosts/hub.ts");
const { sessionOps } = await import("./hosts/session-ops.ts");
const { grantWorkspaceRoot, invalidateWorkspaceRoots } = await import("./hosts/workspace-roots.ts");
const { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } = await import("./session-reader.ts");
const { encodeFilePathForApi, filePathApiSegments, getFileApiUrl } = await import("./file-paths.ts");
const { GET: filesRoute } = await import("../app/api/files/[...path]/route.ts");

const A = "11111111-2222-4333-8444-5555555555aa";
const B = "11111111-2222-4333-8444-5555555555bb";
const R = "11111111-2222-4333-8444-5555555555cc";
const UNKNOWN = "11111111-2222-4333-8444-5555555555dd";

/** Each test's own agent dir, workspace and custom session dir. The custom sessions live outside the agent dir, so no
 * allowed root covers their `local/` directories: only a session's own local-root admission can read them. */
function world(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tau-local-uri-")));
  const agentDir = join(base, "agent");
  const workspace = join(base, "workspace");
  mkdirSync(agentDir);
  mkdirSync(workspace);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const reset = () => {
    globalThis.__tauHostLists = undefined;
    globalThis.__piAllowedRootsCache = undefined;
    invalidateSessionListCache();
    invalidateWorkspaceRoots();
    for (const id of [A, B, R, UNKNOWN]) invalidateSessionPathCache(id);
  };
  reset();
  // The workspace is a root the daemon's user selected, as the daemon's validateCwd records it.
  grantWorkspaceRoot(workspace);
  const links = [];
  const cleanups = [];
  t.after(() => {
    for (const link of links) hub.closeHostLink(link.id);
    hub.flushLinkSamples();
    for (const cleanup of cleanups) cleanup();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    reset();
    rmSync(base, { recursive: true, force: true });
  });

  /** A session whose file `<dir>/<name>.jsonl` (a real header and first message) has omp's artifact directory
   * `<dir>/<name>/local/`. Under `<agent dir>/sessions` the daemon's own list finds it; anywhere else it is a session omp
   * resumed from a custom path, which the daemon knows only through its path cache and listing (`custom`). */
  const session = (id, { dir = join(base, "custom-sessions", "-proj"), name = `2026-01-01_${id.slice(-2)}` } = {}) => {
    const file = join(dir, `${name}.jsonl`);
    const local = join(dir, name, "local");
    mkdirSync(local, { recursive: true });
    writeFileSync(file, [
      { type: "session", version: 3, id, cwd: workspace, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    return {
      id,
      file,
      local,
      custom: !dir.startsWith(join(agentDir, "sessions")),
      entry: { path: file, id, cwd: workspace, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "hi" },
    };
  };
  /** This machine's real daemon workspace service on the current agent dir. */
  const daemon = async (...sessions) => {
    const custom = sessions.filter((s) => s.custom);
    for (const s of custom) cacheSessionPath(s.id, s.file);
    const link = await linkLocalDaemon({ listSessions: async () => [...await sessionOps.listSessions(), ...custom.map((s) => s.entry)] });
    links.push(link);
    return link;
  };
  /** The viewer's request for an absolute path: what its tab does with the resolved path. */
  const read = (path, sessionId, type = "read") =>
    filesRoute(
      new Request(`http://localhost/api/files/${encodeFilePathForApi(path)}?type=${type}${sessionId ? `&sessionId=${sessionId}` : ""}`),
      { params: Promise.resolve({ path: filePathApiSegments(path) }), disableIdleTimeout() {} },
    );
  /** A running omp wrapper for `id`, as main's registry holds it: its host and the session file it reported. */
  const live = (id, sessionFile, { sessionId = id, host = hub.getHost("local"), aliases = [] } = {}) => {
    globalThis.__tauSessions ??= new Map();
    const wrapper = { isAlive: () => true, host, sessionFile, sessionId, cwd: workspace };
    for (const key of [id, ...aliases]) {
      globalThis.__tauSessions.set(`local/${key}`, wrapper);
      t.after(() => globalThis.__tauSessions.delete(`local/${key}`));
    }
  };
  return {
    base,
    agentDir,
    workspace,
    session,
    read,
    live,
    cleanups,
    local: daemon,
  };
}

const refused = async (response, status, code) => {
  const body = await response.json();
  assert.deepEqual([response.status, body.code], [status, code], JSON.stringify(body));
  assert.equal(typeof body.error, "string");
  return body;
};
async function asPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("reads each session's own local bytes, including a nested name with spaces", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  mkdirSync(join(a.local, "nested"));
  writeFileSync(join(a.local, "note.md"), "# alpha note\n");
  writeFileSync(join(a.local, "nested", "name with spaces.md"), "spaces in alpha\n");
  writeFileSync(join(b.local, "note.md"), "# bravo note\n");
  await w.local(a, b);

  const alphaNote = join(a.local, "note.md");
  const spaced = join(a.local, "nested", "name with spaces.md");

  // The viewer's reads of that tab: text, meta and download all carry the file's real bytes.
  const text = await w.read(alphaNote, A);
  assert.equal(text.status, 200);
  assert.deepEqual(await text.json(), { content: "# alpha note\n", language: "markdown", size: 13 });
  assert.equal((await (await w.read(spaced, A)).json()).content, "spaces in alpha\n");
  const meta = await w.read(alphaNote, A, "meta");
  assert.equal((await meta.json()).size, 13);
  const download = await w.read(alphaNote, A, "download");
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "# alpha note\n");

  // Another session's `note.md` is its own file: the session decides the root, never the tab being viewed.
  const bravoNote = join(b.local, "note.md");
  assert.equal((await (await w.read(bravoNote, B)).json()).content, "# bravo note\n");
});

test("an absolute session artifact wins over a workspace file mirroring its pathname", { skip: process.platform === "win32" }, async (t) => {
  // Windows drive-qualified requests are never candidates for workspace-relative fallback.
  const w = world(t);
  const a = w.session(A);
  const artifact = join(a.local, "note.md");
  const decoy = join(w.workspace, ...filePathApiSegments(artifact));
  mkdirSync(dirname(decoy), { recursive: true });
  writeFileSync(artifact, "owning session artifact\n");
  writeFileSync(decoy, "wrong workspace file\n");
  await w.local(a);

  assert.equal((await (await w.read(artifact, A)).json()).content, "owning session artifact\n");
  assert.equal(await (await w.read(artifact, A, "download")).text(), "owning session artifact\n");
  rmSync(artifact);
  await refused(await w.read(artifact, A), 404, "file_not_found");
});

test("a session's tab reads only its own local directory", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  writeFileSync(join(a.local, "note.md"), "alpha\n");
  writeFileSync(join(b.local, "note.md"), "bravo\n");
  await w.local(a, b);

  // B's absolute path under A's session id, or under none: denied by the daemon's own gate. A session no host has is
  // not found before any file is looked at.
  for (const [sessionId, status] of [[A, 403], [undefined, 403], [UNKNOWN, 404], ["not-a-session-id", 404]]) {
    assert.equal((await w.read(join(b.local, "note.md"), sessionId)).status, status, `session ${sessionId}`);
  }
  // The directory itself is not a listing target for a session id: it only authorizes reads.
  assert.equal((await w.read(a.local, A, "list")).status, 403);
});

test("an absent artifact is an explicit not-found, never a workspace or another session's file", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  writeFileSync(join(w.workspace, "absent.md"), "workspace copy\n");
  writeFileSync(join(b.local, "absent.md"), "bravo copy\n");
  await w.local(a, b);

  const missing = await w.read(join(a.local, "absent.md"), A);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "file_not_found");
});

test("the file panel's Download link carries the tab's session id, so a session-local file downloads", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  writeFileSync(join(a.local, "note.md"), "# alpha note\n");
  await w.local(a, b);
  const path = join(a.local, "note.md");
  const download = (url) => filesRoute(
    new Request(`http://localhost${url}`),
    { params: Promise.resolve({ path: filePathApiSegments(path) }), disableIdleTimeout() {} },
  );

  const own = await download(getFileApiUrl(path, "download", "local", A));
  assert.equal(own.status, 200);
  assert.equal(await own.text(), "# alpha note\n");
  // Without the id, or with another session's, the artifact lies outside every root that session may read.
  assert.equal((await download(getFileApiUrl(path, "download", "local", undefined))).status, 403);
  assert.equal((await download(getFileApiUrl(path, "download", "local", B))).status, 403);
});

test("with this machine's daemon unreachable, nothing is answered from main's disk", async (t) => {
  const w = world(t);
  const a = w.session(A);
  writeFileSync(join(a.local, "note.md"), "alpha\n");
  // No daemon is linked: the session's host is unknown, so its files cannot be read.
  await refused(await w.read(join(a.local, "note.md"), A), 503, "host_offline");
  await refused(await w.read(join(a.local, "note.md"), undefined), 503, "host_offline");
});

test("a symlink out of the local root is refused on every read", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const outside = join(w.base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  writeFileSync(join(a.local, "real.md"), "real\n");
  symlinkSync(join(outside, "secret.txt"), join(a.local, "link-out.md"));
  symlinkSync(outside, join(a.local, "linkdir"), DIR_LINK);
  symlinkSync(join(a.local, "real.md"), join(a.local, "link-in.md"));
  symlinkSync(join(outside, "later.txt"), join(a.local, "dangling.md"));
  symlinkSync("loop-b", join(a.local, "loop-a"));
  symlinkSync("loop-a", join(a.local, "loop-b"));
  await w.local(a);

  // A link that stays inside the root is just another file.
  const inner = join(a.local, "link-in.md");
  assert.equal((await (await w.read(inner, A)).json()).content, "real\n");

  // The gate confines the tab's own reads too: knowing the absolute path of a link is not enough.
  assert.equal((await w.read(join(a.local, "link-out.md"), A)).status, 403);
  assert.equal((await w.read(join(a.local, "linkdir", "secret.txt"), A, "download")).status, 403);
  // A dangling link is not found; once its target appears outside the root it is refused.
  assert.equal((await w.read(join(a.local, "dangling.md"), A)).status, 404);
  writeFileSync(join(outside, "later.txt"), "appeared later\n");
  assert.equal((await w.read(join(a.local, "dangling.md"), A)).status, 403);
});

test("a tab opened for a session keeps that session's confinement after a later move to a new id", async (t) => {
  const w = world(t);
  const dir = join(w.agentDir, "sessions", "-proj");
  const a = w.session(A, { dir });
  const b = w.session(B, { dir });
  // Under the agent directory, so the broad agent-root allow-list would admit it if confinement were skipped.
  writeFileSync(join(w.agentDir, "notes.md"), "elsewhere in the agent dir\n");
  writeFileSync(join(a.local, "real.md"), "real\n");
  symlinkSync(join(w.agentDir, "notes.md"), join(a.local, "link-out.md"));
  await w.local(a, b);
  // The tab was created for A; omp then moved the live conversation to B and kept A as an alias.
  w.live(B, b.file, { aliases: [A] });
  assert.equal((await (await w.read(join(a.local, "real.md"), A)).json()).content, "real\n");
  assert.equal((await w.read(join(a.local, "link-out.md"), A)).status, 403, "A's root still confines A's tab");
  assert.equal((await w.read(join(a.local, "link-out.md"), A, "download")).status, 403);
});

test("a default-layout artifact remains confined after a completed symlink replacement", async (t) => {
  const w = world(t);
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  const artifact = join(a.local, "draft.md");
  const outside = join(w.agentDir, "outside.md");
  writeFileSync(artifact, "session draft\n");
  writeFileSync(outside, "outside session local root\n");
  await w.local(a);
  assert.equal(await (await w.read(artifact, A, "download")).text(), "session draft\n");

  rmSync(artifact);
  symlinkSync(outside, artifact);
  for (const type of ["read", "download", "meta"]) {
    await refused(await w.read(artifact, A, type), 403, "access_denied");
  }
});

test("a credential-named session artifact is not omp's own credential store", async (t) => {
  const w = world(t);
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  writeFileSync(join(a.local, "auth.json"), "artifact bytes\n");
  writeFileSync(join(a.local, "plain.md"), "plain\n");
  await w.local(a);

  const artifact = join(a.local, "auth.json");
  assert.equal((await w.read(artifact, A)).status, 200);
  assert.equal(await (await w.read(artifact, A, "download")).text(), "artifact bytes\n");
  // The same directory still opens ordinary artifacts.
  assert.equal((await (await w.read(join(a.local, "plain.md"), A)).json()).content, "plain\n");
});

test("a local directory that links to the agent dir still cannot hand out credentials", async (t) => {
  const w = world(t);
  const a = w.session(A);
  rmSync(a.local, { recursive: true });
  symlinkSync(w.agentDir, a.local, DIR_LINK);
  writeFileSync(join(w.agentDir, "auth.json"), "api keys\n");
  writeFileSync(join(w.agentDir, "models.json"), "apiKey: secret\n");
  writeFileSync(join(w.agentDir, "notes.md"), "plain agent note\n");
  // The same hole with no local directory involved: a workspace file that is a link to a credential file.
  symlinkSync(join(w.agentDir, "auth.json"), join(w.workspace, "innocent.txt"));
  await w.local(a);

  for (const name of ["auth.json", "models.json"]) {
    const path = join(a.local, name);
    assert.equal((await w.read(path, A)).status, 403, `${name} read`);
    assert.equal((await w.read(path, A, "download")).status, 403, `${name} download`);
  }
  assert.equal((await w.read(join(w.workspace, "innocent.txt"), A)).status, 403);
  assert.equal((await w.read(join(w.workspace, "innocent.txt"), A, "download")).status, 403);
  // The directory is not blanket-denied: an ordinary artifact there still opens.
  const notes = join(a.local, "notes.md");
  assert.equal((await (await w.read(notes, A)).json()).content, "plain agent note\n");
});

test("a credential file is refused by its real path when the agent dir itself is a link", async (t) => {
  const w = world(t);
  const a = w.session(A);
  // omp's agent dir is reached through a link, as `~/.omp/agent` is on a machine that keeps its settings elsewhere.
  const realAgent = join(w.base, "real-agent");
  mkdirSync(realAgent);
  symlinkSync(realAgent, join(w.base, "agent-link"), DIR_LINK);
  process.env.PI_CODING_AGENT_DIR = join(w.base, "agent-link"); // world() restores the previous value
  globalThis.__piAllowedRootsCache = undefined;
  invalidateWorkspaceRoots();
  writeFileSync(join(realAgent, "auth.json"), "api keys\n");
  writeFileSync(join(realAgent, "AGENTS.md"), "plain rule file\n");
  // Workspace files that lead to the REAL files: their real paths lie under no config root as named.
  symlinkSync(join(realAgent, "auth.json"), join(w.workspace, "innocent.txt"));
  symlinkSync(join(realAgent, "AGENTS.md"), join(w.workspace, "rules.md"));
  await w.local(a);

  assert.equal((await w.read(join(w.workspace, "innocent.txt"), A)).status, 403);
  assert.equal((await w.read(join(w.workspace, "innocent.txt"), A, "download")).status, 403);
  assert.equal((await w.read(join(w.base, "agent-link", "auth.json"), A)).status, 403);
  // A link to an ordinary file in the same directory still opens.
  assert.equal((await (await w.read(join(w.workspace, "rules.md"), A)).json()).content, "plain rule file\n");
});

test("the session file's own platform rules decide the local root, Windows temp fallback included", async (t) => {
  const w = world(t);
  const id = randomUUID();
  // A root of 180 characters or more is moved to <tmp>/tau-local/<session id> on Windows.
  const long = w.session(id, { name: `2026-01-01_${"x".repeat(160)}` });
  const fallback = join(tmpdir(), "tau-local", id);
  mkdirSync(fallback, { recursive: true });
  w.cleanups.push(() => rmSync(fallback, { recursive: true, force: true }));
  writeFileSync(join(fallback, "note.md"), "from the short root\n");
  writeFileSync(join(long.local, "note.md"), "from the long root\n");
  await w.local(long);

  const onWindows = await asPlatform("win32", async () => (await w.read(join(fallback, "note.md"), id)).json());
  assert.equal(onWindows.content, "from the short root\n");
  // Anywhere else the artifact directory beside the session file is the root. (On Windows itself a root this long
  // always takes the temp fallback, so there is no such directory to compare.)
  if (process.platform !== "win32") {
    assert.equal((await (await w.read(join(long.local, "note.md"), id)).json()).content, "from the long root\n");
  }
});

test("ordinary absolute and workspace-relative opens behave as before", async (t) => {
  const w = world(t);
  const a = w.session(A);
  writeFileSync(join(w.workspace, "README.md"), "workspace readme\n");
  await w.local(a);

  // Inside an allowed root: with or without a session id.
  for (const sessionId of [undefined, A]) {
    const absolute = await w.read(join(w.workspace, "README.md"), sessionId);
    assert.equal(absolute.status, 200);
    assert.equal((await absolute.json()).content, "workspace readme\n");
  }
  // A bare workspace path still fans out over the allowed roots.
  const relative = await filesRoute(
    new Request(`http://localhost/api/files/README.md?type=read&sessionId=${A}`),
    { params: Promise.resolve({ path: ["README.md"] }), disableIdleTimeout() {} },
  );
  assert.equal((await relative.json()).content, "workspace readme\n");
  // Outside every root, and no session's local directory: still a 403.
  assert.equal((await w.read(join(w.base, "agent-less-file.txt"), A)).status, 403);
  assert.equal((await w.read("/etc/passwd", A)).status, 403);
  // `local:` is no scheme the generic file API knows: its mangled form never selects a file.
  const mangled = await filesRoute(
    new Request(`http://localhost/api/files/local%3A/note.md?type=read&sessionId=${A}`),
    { params: Promise.resolve({ path: ["local:", "note.md"] }), disableIdleTimeout() {} },
  );
  assert.equal(mangled.status, 403);
});

test("a live session names its local directory from its own session file, before the daemon's list has it", async (t) => {
  const w = world(t);
  await w.local();
  await sessionOps.listSessions(); // the daemon's list is now cached without the session below
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  writeFileSync(join(a.local, "draft.md"), "live draft\n");
  assert.equal(await sessionOps.listSessions().then((list) => list.some((s) => s.id === A)), false, "the list lags the new file");
  w.live(A, a.file);

  const path = join(a.local, "draft.md");
  assert.equal((await (await w.read(path, A)).json()).content, "live draft\n");
  assert.equal(await (await w.read(path, A, "download")).text(), "live draft\n");
});

test("a live session's file hint is only a hint: the daemon trusts it only for a file it can vouch for", async (t) => {
  const w = world(t);
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  const b = w.session(B);
  // C is a custom session the daemon knows, outside every allowed root: only its own id can reach its directory.
  const c = w.session(R);
  for (const s of [a, b, c]) writeFileSync(join(s.local, "note.md"), `${s.id.slice(-2)} artifact\n`);
  await w.local(c);

  // A custom-directory file the daemon has never heard of is not a root source, however the live session names it.
  w.live(B, b.file);
  assert.equal((await w.read(join(b.local, "note.md"), B)).status, 403);
  // Once the daemon knows that file (omp resumed it), the same hint is the file.
  cacheSessionPath(B, b.file);
  assert.equal((await (await w.read(join(b.local, "note.md"), B)).json()).content, "bb artifact\n");

  // A hint that is another session's file (its header names another id) never selects that session's directory.
  w.live(A, c.file);
  assert.equal((await (await w.read(join(a.local, "note.md"), A)).json()).content, "aa artifact\n", "the daemon falls back to the file it knows for the id");
  assert.equal((await w.read(join(c.local, "note.md"), A)).status, 403);
  // A hint outside every session file the daemon holds, even one with a matching header, cannot widen the root.
  const elsewhere = join(w.base, "elsewhere", "2026-01-01_aa.jsonl");
  mkdirSync(join(w.base, "elsewhere", "2026-01-01_aa", "local"), { recursive: true });
  writeFileSync(elsewhere, `${JSON.stringify({ type: "session", version: 3, id: A, cwd: w.workspace, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
  writeFileSync(join(w.base, "elsewhere", "2026-01-01_aa", "local", "note.md"), "decoy\n");
  w.live(A, elsewhere);
  assert.equal((await w.read(join(w.base, "elsewhere", "2026-01-01_aa", "local", "note.md"), A)).status, 403);
});
