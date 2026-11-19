// Session-local files (composer uploads) across real processes: each daemon is a separate Node child with its own home
// and agent dir, and the file is read and downloaded on the host that owns the session, through the real HTTP routes.
// Main's own agent dir holds a lookalike of every session, so an answer built from main's disk cannot pass for the daemon's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { before, after } from "node:test";
import { workspaceHarness } from "./workspace-test-helper.mjs";

let h, local, owner, other;
before(async () => {
  h = await workspaceHarness();
  local = await h.startHost(true);
  owner = await h.startHost();
  other = await h.startHost();
});
after(async () => h?.close());

/** A session (its real JSONL under `agentDir`'s sessions dir) and its artifact directory with `files`. */
function session(agentDir, cwd, id, files = {}, name = `2026-11-03_${id}`) {
  const dir = join(agentDir, "sessions", "-proj");
  const local = join(dir, name, "local");
  mkdirSync(local, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), [
    { type: "session", version: 3, id, cwd, timestamp: "2026-11-03T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-11-03T00:00:01.000Z", message: { role: "user", content: "hi" } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(local, file), bytes);
  return { id, local };
}
const mainAgentDir = () => join(h.root, "main-agent");
/** The same session id on main's own disk, with a different `note.md`. */
const lookalike = (id) => session(mainAgentDir(), h.root, id, { "note.md": "main's lookalike bytes\n" });

test("a session-local file is read on the host that owns the session, not from main's disk", async () => {
  const id = randomUUID();
  const mine = session(owner.agentDir, owner.project, id, { "note.md": "owner bytes\n" });
  lookalike(id);
  await owner.host.invalidateSessionLists();
  const answer = { path: join(mine.local, "note.md") };

  // The tab's reads follow the session to the same host, named or not.
  const read = await h.file(owner.id, answer.path, "read", { sessionId: id });
  assert.deepEqual(await read.json(), { content: "owner bytes\n", language: "markdown", size: 12 });
  assert.equal(await (await h.file(owner.id, answer.path, "download", { sessionId: id })).text(), "owner bytes\n");
  assert.equal((await (await h.file(owner.id, answer.path, "meta", { sessionId: id })).json()).size, 12);
  const unnamed = await fetch(`${h.url}/api/files/${encodeURIComponent(answer.path)}?type=read&sessionId=${id}`);
  assert.equal((await unnamed.json()).content, "owner bytes\n");
  // Another host is not the session's: it never answers for it.
  assert.equal((await h.file(other.id, answer.path, "read", { sessionId: id })).status, 409);
});

test("two sessions of one host name only their own files", async () => {
  const x = randomUUID();
  const y = randomUUID();
  const sx = session(owner.agentDir, owner.project, x, { "note.md": "x bytes\n" });
  const sy = session(owner.agentDir, owner.project, y, { "note.md": "y bytes\n" });
  await owner.host.invalidateSessionLists();

  const px = join(sx.local, "note.md");
  const py = join(sy.local, "note.md");
  assert.equal((await (await h.file(owner.id, py, "read", { sessionId: y })).json()).content, "y bytes\n");
  assert.equal((await h.file(owner.id, px, "download", { sessionId: x })).status, 200);
});

test("this machine's own session is read by its daemon process too", async () => {
  const id = randomUUID();
  const mine = session(local.agentDir, local.project, id, { "note.md": "local daemon bytes\n" });
  lookalike(id);
  await local.host.invalidateSessionLists();
  assert.equal((await (await h.file(local.id, join(mine.local, "note.md"), "read", { sessionId: id })).json()).content, "local daemon bytes\n");
});

test("a link out of the artifact directory and a link to the credential store are refused on the daemon", async () => {
  const id = randomUUID();
  const mine = session(owner.agentDir, owner.project, id, { "note.md": "owner bytes\n" });
  // Inside the agent dir, an allowed root: only the artifact directory's own confinement refuses the link.
  const outside = join(owner.agentDir, "outside.md");
  writeFileSync(outside, "outside the local root\n");
  symlinkSync(outside, join(mine.local, "link-out.md"));
  await owner.host.invalidateSessionLists();

  assert.equal((await h.file(owner.id, join(mine.local, "link-out.md"), "read", { sessionId: id })).status, 403);

  // The whole artifact directory linked to the agent dir still hands out no credential.
  const linked = session(owner.agentDir, owner.project, randomUUID());
  rmSync(linked.local, { recursive: true });
  symlinkSync(owner.agentDir, linked.local, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(owner.agentDir, "agent.db"), "api keys\n");
  await owner.host.invalidateSessionLists();
  assert.equal((await h.file(owner.id, join(linked.local, "agent.db"), "download", { sessionId: linked.id })).status, 403);
});

test("artifact confinement distinguishes a POSIX backslash root from its slash-spelled namesake", { skip: process.platform === "win32" }, async () => {
  const id = randomUUID();
  const mine = session(owner.agentDir, owner.project, id, { "note.md": "own bytes\n" }, `2026-11-05_${id}\\branch`);
  const outside = mine.local.replace(/\\/g, "/");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "private.md"), "outside bytes\n");
  symlinkSync(join(outside, "private.md"), join(mine.local, "escape.md"));
  await owner.host.invalidateSessionLists();
  assert.equal((await h.file(owner.id, join(mine.local, "escape.md"), "read", { sessionId: id })).status, 403);
  assert.equal((await (await h.file(owner.id, join(mine.local, "note.md"), "read", { sessionId: id })).json()).content, "own bytes\n");
});
