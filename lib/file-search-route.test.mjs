import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const { MAX_TEXT_MATCHES } = await import("./file-index.ts");

async function search(cwd, params) {
  const url = new URL("http://localhost/api/file-search");
  url.searchParams.set("cwd", cwd);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const res = await GET(new Request(url.toString()));
  return { status: res.status, body: await res.json() };
}

test("text search finds literal matches in the workspace's text files", async () => {
  const daemon = await linkLocalDaemon();
  const dir = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(dir, "src", "a.ts"), "const Needle = 1;\nnothing\n  needle(a.b)\n");
  writeFileSync(join(dir, "long.min.js"), `${"x".repeat(5000)}needle${"y".repeat(5000)}`);
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, ...Buffer.from("needle")]));
  writeFileSync(join(outside, "secret.txt"), "needle\n");
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  await getHost("local").sessionOps.validateCwd(dir);
  try {
    const { status, body } = await search(dir, { q: "needle" });
    assert.equal(status, 200);
    assert.equal(body.truncated, false);
    const found = body.matches.map((m) => `${m.path}:${m.line}`).sort();
    // Binary files and symlinks are skipped; the match is case-insensitive.
    assert.deepEqual(found, ["long.min.js:1", "src/a.ts:1", "src/a.ts:3"]);
    for (const match of body.matches) assert.equal(match.text.slice(match.column, match.column + match.length).toLowerCase(), "needle");
    assert.ok(body.matches.find((m) => m.path === "long.min.js").text.length <= 240, "long lines are cut to an excerpt");
    // Literal, not a pattern; case-sensitive on request.
    assert.deepEqual((await search(dir, { q: "(a.b)" })).body.matches.map((m) => m.line), [3]);
    assert.deepEqual((await search(dir, { q: "Needle", case: 1 })).body.matches.map((m) => m.line), [1]);
    // An empty query and a cwd outside the workspace roots are refused.
    assert.equal((await search(dir, { q: "" })).status, 400);
    assert.equal((await search(outside, { q: "needle" })).status, 403);
    // The cap says it cut.
    writeFileSync(join(dir, "many.txt"), "needle\n".repeat(MAX_TEXT_MATCHES + 10));
    const capped = (await search(dir, { q: "needle" })).body;
    assert.equal(capped.matches.length, MAX_TEXT_MATCHES);
    assert.equal(capped.truncated, true);
  } finally {
    daemon.drop(); await daemon.workspace.stop();
    flushLinkSamples();
  }
});
