import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "tau-trust-args-")));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const { projectTrustArgs } = await import("./local-host.ts");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
const register = (projects) => {
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "projects.json"), JSON.stringify({ version: 1, projects }));
};

test("--approve only for a cwd inside a workspace registered on this machine, its subdirectories and linked worktrees", async () => {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const linked = join(dir, ".repo_worktrees", "feature");
  git(repo, "worktree", "add", "-q", "-b", "feature", linked);
  mkdirSync(join(linked, "deep"), { recursive: true });
  const sibling = join(dir, "repo-worktrees", "other");
  mkdirSync(sibling, { recursive: true });
  const stranger = join(dir, "stranger");
  mkdirSync(stranger);

  register([]);
  assert.deepEqual(await projectTrustArgs(repo), [], "nothing registered: pi's own trust rules");

  register([{ path: repo }]);
  for (const cwd of [repo, join(repo, "sub"), linked, join(linked, "deep"), sibling]) {
    assert.deepEqual(await projectTrustArgs(cwd), ["--approve"], cwd);
  }
  assert.deepEqual(await projectTrustArgs(stranger), []);
  assert.deepEqual(await projectTrustArgs(`${repo}x`), [], "a name prefix is not inside");

  register([{ path: repo, hidden: true }]);
  assert.deepEqual(await projectTrustArgs(repo), [], "a removed (hidden) workspace is not trusted");
});
