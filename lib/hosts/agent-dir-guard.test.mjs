import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tau-agent-dir-guard-")));
const home = join(scratch, "home");
const worktree = join(scratch, "worktree");
const agent = join(worktree, "agent");
mkdirSync(home);
mkdirSync(agent, { recursive: true });
const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.PI_CODING_AGENT_DIR = agent;
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});
const { assertOutsideAgentDir, assertRemovableOutsideAgentDir } = await import("./workspace-roots.ts");
const refused = (code) => (error) => error.status === 403 && error.code === code;

test("an agent directory (or ~/.pi) that does not exist yet is still protected: a clone must not create it", () => {
  const missing = join(home, ".pi", "agent");
  process.env.PI_CODING_AGENT_DIR = missing;
  try {
    assert.throws(() => assertOutsideAgentDir(missing), refused("agent_dir_read_only"));
    assert.throws(() => assertOutsideAgentDir(join(missing, "skills")), refused("agent_dir_read_only"));
    assert.doesNotThrow(() => assertOutsideAgentDir(join(home, "project")));
  } finally {
    process.env.PI_CODING_AGENT_DIR = agent;
  }
});

test("writing into a directory that holds the agent directory is fine; removing it is not", () => {
  assert.doesNotThrow(() => assertOutsideAgentDir(worktree), "an upload beside the agent directory");
  assert.throws(() => assertRemovableOutsideAgentDir(worktree), refused("agent_dir_read_only"));
  assert.doesNotThrow(() => assertRemovableOutsideAgentDir(join(scratch, "elsewhere")));
});

test("a path that cannot be checked is refused as such, not blamed on the agent directory", () => {
  const loop = join(scratch, "loop");
  symlinkSync(loop, loop);
  assert.throws(() => assertOutsideAgentDir(join(loop, "child")), refused("access_denied"));
});
