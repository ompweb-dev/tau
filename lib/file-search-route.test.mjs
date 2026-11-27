import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "tau-file-search-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

const { GET } = await import("../app/api/file-search/route.ts");
const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
const { getHost, flushLinkSamples } = await import("./hosts/hub.ts");
const { MAX_TEXT_MATCHES, textSearchLimits, searchWorkspaceText } = await import("./file-index.ts");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

async function search(cwd, params) {
  const url = new URL("http://localhost/api/file-search");
  url.searchParams.set("cwd", cwd);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const res = await GET(new Request(url.toString()));
  return { status: res.status, body: await res.json() };
}
const found = async (cwd, q) => (await search(cwd, { q })).body.matches.map((m) => `${m.path}:${m.line}`).sort();

test("text search reads only the workspace's own text files", async () => {
  const daemon = await linkLocalDaemon();
  const dir = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "d"));
  mkdirSync(outside);
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "const Needle = 1;\nnothing\n  needle(a.b)\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, ...Buffer.from("needle")]));
  writeFileSync(join(dir, "big.log"), `needle\n${"x".repeat(300 * 1024)}`);
  writeFileSync(join(dir, "d", "x.txt"), "inside\n");
  writeFileSync(join(outside, "x.txt"), "needle outside\n");
  writeFileSync(join(root, "agent", "auth.json"), '{"key":"needle"}\n');
  // A configured credential file that is a symlink to a file in the workspace.
  writeFileSync(join(dir, "creds.txt"), "needle token\n");
  symlinkSync(join(dir, "creds.txt"), join(root, "agent", "oauth.json"));
  symlinkSync(join(outside, "x.txt"), join(dir, "link.txt"));
  symlinkSync("loop", join(dir, "loop"));
  git(root, "init", "-q", dir);
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  // A tracked directory swapped for a symlink out of the workspace keeps its listing.
  rmSync(join(dir, "d"), { recursive: true });
  symlinkSync(outside, join(dir, "d"));
  // A hard link to a credential file is skipped wherever it sits.
  linkSync(join(root, "agent", "auth.json"), join(dir, "copy.json"));
  await getHost("local").sessionOps.validateCwd(dir);
  try {
    const { status, body } = await search(dir, { q: "needle" });
    assert.equal(status, 200);
    assert.equal(body.cwd, dir);
    assert.equal(body.truncated, false);
    // Binary, over the preview size, symlinked, outside through a parent, credentials, a symlink loop: all skipped.
    assert.deepEqual(body.matches.map((m) => `${m.path}:${m.line}`).sort(), ["src/a.ts:1", "src/a.ts:3"]);
    for (const match of body.matches) assert.equal(match.text.slice(match.column, match.column + match.length).toLowerCase(), "needle");
    // Literal, not a pattern; case-sensitive on request.
    assert.deepEqual(await found(dir, "(a.b)"), ["src/a.ts:3"]);
    assert.deepEqual((await search(dir, { q: "Needle", case: 1 })).body.matches.map((m) => m.line), [1]);
    // An empty or over-long query and a cwd outside the workspace roots are refused.
    assert.equal((await search(dir, { q: "" })).status, 400);
    assert.equal((await search(dir, { q: "n".repeat(501) })).status, 400);
    assert.equal((await search(outside, { q: "needle" })).status, 403);
    // A client name is optional (servers that predate it send none) but bounded.
    assert.equal((await search(dir, { q: "needle", client: "c".repeat(65) })).status, 200, "the route cuts it to 64");
  } finally {
    daemon.drop(); await daemon.workspace.stop();
    flushLinkSamples();
  }
});

test("text search excerpts long lines, caps matches and keeps to its budget", async () => {
  const daemon = await linkLocalDaemon();
  const dir = join(root, "caps");
  mkdirSync(dir);
  const query = `q${"u".repeat(298)}x`;
  // The second line's excerpt would start, the third's end, inside a surrogate pair.
  writeFileSync(join(dir, "long.min.js"), `${"a".repeat(5000)}${query}${"b".repeat(5000)}\n${"😀".repeat(3000)}yneedle\nneedlex${"😀".repeat(3000)}\n`);
  await getHost("local").sessionOps.validateCwd(dir);
  try {
    const long = (await search(dir, { q: query })).body.matches[0];
    assert.equal(long.text.length, 240, "long lines are cut to an excerpt");
    assert.equal(long.column + long.length, long.text.length, "a match longer than the excerpt is cut at its end");
    const emoji = (await search(dir, { q: "needle" })).body.matches;
    assert.equal(emoji.length, 2);
    for (const match of emoji) {
      assert.equal(match.text.slice(match.column, match.column + match.length), "needle");
      assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(match.text), "the excerpt never splits a surrogate pair");
    }

    writeFileSync(join(dir, "many.txt"), "needle\n".repeat(MAX_TEXT_MATCHES - 2));
    const exact = (await search(dir, { q: "needle" })).body;
    assert.equal(exact.matches.length, MAX_TEXT_MATCHES);
    assert.equal(exact.truncated, false, "exactly the cap is not truncated");
    writeFileSync(join(dir, "more.txt"), "needle\n");
    const capped = (await search(dir, { q: "needle" })).body;
    assert.equal(capped.matches.length, MAX_TEXT_MATCHES);
    assert.equal(capped.truncated, true);

    textSearchLimits.budgetMs = -1;
    try {
      const timed = (await search(dir, { q: "needle" })).body;
      assert.deepEqual([timed.matches.length, timed.truncated], [0, true]);
    } finally { textSearchLimits.budgetMs = 10_000; }
  } finally {
    daemon.drop(); await daemon.workspace.stop();
    flushLinkSamples();
  }
});

test("a newer search by the same client stops its older one, and only that one", async () => {
  const dir = join(root, "supersede");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.txt"), "needle\n");
  const older = searchWorkspaceText(dir, "needle", false, "panel-1");
  const other = searchWorkspaceText(dir, "needle", false, "panel-2");
  const newer = searchWorkspaceText(dir, "needle", false, "panel-1");
  assert.deepEqual(await older, { cwd: dir, matches: [], truncated: true });
  assert.equal((await other).matches.length, 1);
  assert.deepEqual([(await newer).matches.length, (await newer).truncated], [1, false]);
});

test("hard-linked files are searched; a hard link to a credential file is not", async () => {
  const dir = join(root, "hardlinks");
  mkdirSync(dir);
  mkdirSync(join(root, "agent", "tau"), { recursive: true });
  writeFileSync(join(root, "agent", "models.json"), '{"key":"needle"}\n');
  writeFileSync(join(root, "agent", "tau", "hosts.json"), '{"key":"needle"}\n');
  // A package store (pnpm) hard-links many ordinary files; a hard link to a credential is still skipped.
  writeFileSync(join(root, "shared.txt"), "needle shared\n");
  for (let i = 0; i < 50; i++) linkSync(join(root, "shared.txt"), join(dir, `copy-${i}.txt`));
  linkSync(join(root, "agent", "models.json"), join(dir, "models-copy.json"));
  linkSync(join(root, "agent", "tau", "hosts.json"), join(dir, "hosts-copy.json"));
  // A cluster config copy deeper in tau/ is a credential too.
  mkdirSync(join(root, "agent", "tau", "cluster-config", "objects"), { recursive: true });
  writeFileSync(join(root, "agent", "tau", "cluster-config", "objects", "0a1b"), '{"key":"needle"}\n');
  linkSync(join(root, "agent", "tau", "cluster-config", "objects", "0a1b"), join(dir, "object-copy.json"));
  const result = await searchWorkspaceText(dir, "needle", false);
  assert.equal(result.matches.length, 50);
  assert.ok(result.matches.every((match) => match.path.startsWith("copy-")), "the credentials' hard links are not read");
});

test("an agent-dir name that is not UTF-8 sends hard-linked files to the full check, which refuses", { skip: process.platform !== "linux" && "byte filenames are Linux-only" }, async () => {
  const dir = join(root, "bytes");
  mkdirSync(dir);
  const agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
  // An editor backup of auth.json whose suffix is not UTF-8: its inode cannot be listed by name.
  const backup = Buffer.concat([Buffer.from(`${agent}/auth.json~`), Buffer.from([0xff])]);
  writeFileSync(backup, '{"key":"needle"}\n');
  try {
    linkSync(backup, join(dir, "copy.txt"));
    await assert.rejects(searchWorkspaceText(dir, "needle", false), (error) => error.status === 503, "never read as an ordinary file");
  } finally {
    rmSync(backup, { force: true });
  }
  // Another byte-named file there is no credential: search goes on.
  const other = Buffer.concat([Buffer.from(`${agent}/notes`), Buffer.from([0xff])]);
  writeFileSync(other, "x\n");
  try {
    rmSync(join(dir, "copy.txt"));
    writeFileSync(join(dir, "plain.txt"), "needle\n");
    assert.deepEqual((await searchWorkspaceText(dir, "needle", false)).matches.map((match) => match.path), ["plain.txt"]);
  } finally {
    rmSync(other, { force: true });
  }
});
