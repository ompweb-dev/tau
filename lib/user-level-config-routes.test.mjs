// Settings routes for a cluster member (spec K7). Requests without a cwd act on the user level only: omp runs in its
// agent directory, where no project lies, and project-scope entries are left out.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mock } from "bun:test";

const scratch = realpathSync(mkdtempSync(join(os.tmpdir(), "tau-user-level-")));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir);
const log = join(scratch, "calls.log");
mkdirSync(join(agentDir, "skills", "mine"), { recursive: true });
writeFileSync(join(agentDir, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: Mine.\n---\n");
// A project's skill, which a user-level listing never reads: pi runs in the agent directory.
mkdirSync(join(agentDir, ".pi", "skills", "theirs"), { recursive: true });
writeFileSync(join(agentDir, ".pi", "skills", "theirs", "SKILL.md"), "---\nname: theirs\ndescription: Theirs.\n---\n");
// `pi list` prints each package's source, then its installed path.
writeFileSync(join(scratch, "plugins.txt"), [
  "User packages:", "  global-npm", `    ${join(scratch, "missing")}`, "  mine@market", `    ${join(scratch, "mine")}`,
  "", "Project packages:", "  here@market", `    ${join(scratch, "here")}`, "",
].join("\n"));
const bin = join(scratch, "omp");
writeFileSync(bin, `#!/bin/sh
echo "$(pwd) $*" >> '${log}'
case "$1 $2" in
  "list ") cat '${join(scratch, "plugins.txt")}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });

// Nothing of the real home is read: tau's own lookups (skill locks, MCP files) go under the scratch home. Bun's
// os.homedir() ignores a HOME set at run time, so it is replaced too.
const ENV_KEYS = ["TAU_PI_BIN", "PI_CODING_AGENT_DIR", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
const home = join(scratch, "home");
mkdirSync(home);
process.env.TAU_PI_BIN = bin;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = process.env.USERPROFILE = home;
const scratchOs = { ...os, homedir: () => home };
mock.module("os", () => ({ ...scratchOs, default: scratchOs }));
mock.module("node:os", () => ({ ...scratchOs, default: scratchOs }));
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const skills = await import("../app/api/skills/route.ts");
const skillsCheck = await import("../app/api/skills/check/route.ts");
const skillsUpdate = await import("../app/api/skills/update/route.ts");
const plugins = await import("../app/api/plugins/route.ts");

const calls = () => readFileSync(log, "utf8").trim().split("\n");
const post = (route, body) => route.POST(new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const skip = process.platform === "win32";

test("skills without a cwd: the user's only, with `pi list` run in its agent directory", { skip }, async () => {
  writeFileSync(log, "");
  const response = await skills.GET(new Request("http://localhost/api/skills"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).skills.map((skill) => skill.name), ["mine"]);
  assert.deepEqual(calls(), [`${agentDir} list`]);
});

test("a skill check or update without a cwd is for the user's own installs; a project one needs its cwd", { skip }, async () => {
  const checked = await post(skillsCheck, {});
  assert.equal(checked.status, 200);
  assert.deepEqual(await checked.json(), { updates: [] });
  assert.equal((await post(skillsCheck, { package: "o/r@x", scope: "project" })).status, 400);
  assert.equal((await post(skillsUpdate, { package: "o/r@x", scope: "global" })).status, 404, "past the cwd check: no such install");
  assert.equal((await post(skillsUpdate, { package: "o/r@x", scope: "project" })).status, 400);
});

test("plugins without a cwd: the user's only, and only global changes", { skip }, async () => {
  writeFileSync(log, "");
  const listed = await plugins.GET(new Request("http://localhost/api/plugins"));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).packages.map((pkg) => pkg.source), ["global-npm", "mine@market"]);

  const installed = await post(plugins, { action: "install", source: "npm:demo", scope: "global" });
  assert.equal(installed.status, 200);
  assert.deepEqual((await installed.json()).packages.map((pkg) => pkg.source), ["global-npm", "mine@market"]);
  assert.deepEqual(calls(), [`${agentDir} list`, `${agentDir} install npm:demo`, `${agentDir} list`]);

  const project = await post(plugins, { action: "install", source: "npm:demo", scope: "project" });
  assert.equal(project.status, 400);
  assert.equal(calls().length, 3, "nothing ran");

  writeFileSync(log, "");
  assert.equal((await post(plugins, { action: "update", scope: "global" })).status, 200);
  assert.equal(calls()[0], `${agentDir} update --extensions`, "a bare `pi update` would update pi itself");
});

test("a missing agent directory is created owner-only before omp runs there, not reported as a missing omp", { skip }, async (t) => {
  const fresh = join(scratch, "fresh", "agent");
  process.env.PI_CODING_AGENT_DIR = fresh;
  t.after(() => { process.env.PI_CODING_AGENT_DIR = agentDir; });
  writeFileSync(log, "");
  const listed = await plugins.GET(new Request("http://localhost/api/plugins"));
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.deepEqual([body.packages.map((pkg) => pkg.source), body.diagnostics], [["global-npm", "mine@market"], []]);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
  assert.deepEqual(calls(), [`${fresh} list`]);

  rmSync(join(scratch, "fresh"), { recursive: true });
  const installed = await post(plugins, { action: "install", source: "npm:demo", scope: "global" });
  assert.equal(installed.status, 200);
  rmSync(join(scratch, "fresh"), { recursive: true });
  const skillList = await skills.GET(new Request("http://localhost/api/skills"));
  assert.equal(skillList.status, 200);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
  assert.equal(calls().at(-1), `${fresh} list`);
});
