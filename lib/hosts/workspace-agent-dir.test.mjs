import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tau-agent-dir-writes-")));
const agent = join(scratch, "agent");
const previousAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agent;
mkdirSync(join(agent, "skills"), { recursive: true });
// Load only after selecting this test file's private agent directory.
const { StagedUploads } = await import("./uploads.ts");
const { grantWorkspaceRoot } = await import("./workspace-roots.ts");
const { createWorkspaceService } = await import("./workspace-ops.ts");

const workspace = join(scratch, "workspace");
mkdirSync(workspace);
mkdirSync(join(scratch, "staging"));
grantWorkspaceRoot(workspace);
symlinkSync(join(agent, "skills"), join(workspace, "skills-link"));
const acks = [];
const staged = new StagedUploads((ack) => acks.push(ack), join(scratch, "staging"));
const service = createWorkspaceService(staged, () => {});
after(async () => {
  await service.stop();
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  rmSync(scratch, { recursive: true, force: true });
});

async function ready(name) {
  const id = randomUUID();
  await staged.start({ id, attempt: randomUUID(), name, size: 5, type: "text/plain" });
  staged.write(id, Buffer.from("bytes"));
  for (const deadline = Date.now() + 2000; !acks.some((ack) => ack.id === id && ack.done); await delay(5)) {
    assert.ok(Date.now() < deadline, "the staged fixture must finish");
  }
  return id;
}

function refused(result) {
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "agent_dir_read_only");
}

const intoAgent = {
  direct: agent,
  subdirectory: join(agent, "skills"),
  symlink: join(workspace, "skills-link"),
  dotdot: `${workspace}/../agent/skills`,
};

for (const [form, directory] of Object.entries(intoAgent)) {
  test(`publication and its upload check refuse the agent directory (${form})`, async () => {
    refused(await service.ops.inspectUploads(directory, ["x.txt"]));
    const id = await ready("x.txt");
    refused(await service.ops.publishUpload(id, directory, "x.txt", "overwrite"));
    assert.equal(existsSync(join(agent, "x.txt")) || existsSync(join(agent, "skills", "x.txt")), false);
    assert.deepEqual(readdirSync(join(agent, "skills")), [], "no candidate is left behind");
    await staged.abort(id);
  });

  test(`a clone into the agent directory is refused (${form})`, async () => {
    refused(await service.ops.startClone(randomUUID(), directory, "https://example.invalid/repo.git"));
    assert.equal(existsSync(join(agent, "repo.git")) || existsSync(join(agent, "skills", "repo")), false);
  });
}

test("publication outside the agent directory still works", async () => {
  const id = await ready("ok.txt");
  const published = await service.ops.publishUpload(id, workspace, "ok.txt", "error");
  assert.equal(published.ok, true);
  assert.equal(readFileSync(join(workspace, "ok.txt"), "utf8"), "bytes");
});

test("worktree add and remove refuse a repository in the agent directory", async () => {
  const repo = join(agent, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  refused(await service.ops.addWorktree(repo, "feature"));
  assert.equal(existsSync(`${repo}-worktrees`), false);
  const outside = join(scratch, "outside-tree");
  git("worktree", "add", "-q", "-b", "other", outside);
  refused(await service.ops.removeWorktree(repo, outside, true));
  assert.equal(existsSync(outside), true);
});

test("composer attachment into the session's local/uploads under the agent directory still works", async () => {
  const sessionId = randomUUID();
  const sessionFile = join(agent, "sessions", "--project--", `${sessionId}.jsonl`);
  mkdirSync(join(agent, "sessions", "--project--"), { recursive: true });
  const id = await ready("note.txt");
  const attached = await staged.attach(id, sessionFile, sessionId);
  assert.ok(attached.path.startsWith(agent));
  assert.equal(readFileSync(attached.path, "utf8"), "bytes");
});
