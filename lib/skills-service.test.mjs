import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const {
  discoverSkills,
  getSkillScanRootDirs,
  loadSkillsWithInstallInfo,
  loadUserSkillsWithInstallInfo,
  parseSkillFrontmatter,
  readDisableModelInvocation,
  setDisableModelInvocation,
} = await import("./skills-service.ts");
// The toggle route authorizes existing files through the consolidated facade.
const { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } = await import("./file-access.ts");
const { PATCH } = await import("../app/api/skills/route.ts");

/** Fake pi: a shell script (POSIX) or .cmd launcher (Windows). */
function writeStubPi(dir, posixBody, cmdBody) {
  if (process.platform === "win32") {
    const bin = join(dir, "pi.cmd");
    writeFileSync(bin, cmdBody.map((line) => `@${line}\r\n`).join(""));
    return bin;
  }
  const bin = join(dir, "pi");
  writeFileSync(bin, `#!/bin/sh\n${posixBody.join("\n")}\n`, { mode: 0o755 });
  return bin;
}

function skillFile(frontmatter) {
  return `---\nname: demo\ndescription: A demo skill.\n${frontmatter}---\n\n# Demo\n\nBody text.\n`;
}

function flagOf(content) {
  return readDisableModelInvocation(parseSkillFrontmatter(content).frontmatter);
}

test("adds the key pi reads when it is absent", () => {
  const out = setDisableModelInvocation(skillFile(""), true);
  assert.match(out, /^---\ndisable-model-invocation: true\nname: demo\n/);
  assert.equal(flagOf(out), true);
});

test("replaces an existing disable-model-invocation line instead of duplicating it", () => {
  const out = setDisableModelInvocation(skillFile("disable-model-invocation: false\n"), true);
  assert.equal(out.match(/^disable-model-invocation\s*:/gm).length, 1);
  // Duplicate keys would make the frontmatter unparseable YAML.
  assert.doesNotThrow(() => parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(out)[1]));
  assert.equal(flagOf(out), true);
});

test("clears the key when re-enabling model invocation", () => {
  const out = setDisableModelInvocation(skillFile("disable-model-invocation: true\n"), false);
  assert.doesNotMatch(out, /disable-model-invocation/);
  assert.equal(flagOf(out), false);
  assert.match(out, /name: demo/);
});

test("reads only what pi reads: `disable-model-invocation: true`", () => {
  for (const extra of ["hide: true\n", "disableModelInvocation: true\n", "disable-model-invocation: \"true\"\n"]) {
    assert.equal(flagOf(skillFile(extra)), false, extra);
  }
});

test("leaves indented keys of nested mappings alone", () => {
  const content = skillFile("metadata:\n  disable-model-invocation: true\n");
  const out = setDisableModelInvocation(content, true);
  assert.match(out, /metadata:\n {2}disable-model-invocation: true/);
  assert.match(out, /^disable-model-invocation: true$/m);
});

test("prepends frontmatter when the file has none", () => {
  const out = setDisableModelInvocation("# Demo\n\nBody.\n", true);
  assert.equal(out, "---\ndisable-model-invocation: true\n---\n# Demo\n\nBody.\n");
  assert.equal(setDisableModelInvocation("# Demo\n", false), "# Demo\n");
});

test("preserves CRLF line endings", () => {
  const content = "---\r\nname: demo\r\ndisable-model-invocation: true\r\n---\r\nBody\r\n";
  const out = setDisableModelInvocation(content, false);
  assert.equal(out, "---\r\nname: demo\r\n---\r\nBody\r\n");
});

function withAgentDir(dir) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  return () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
}

function write(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf8");
}

const named = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} fixture.\n${extra}---\n\nBody\n`;

test("scan roots are the directories pi auto-discovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "tau-skill-roots-"));
  const restore = withAgentDir(dir);
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "pkg");
    assert.deepEqual(getSkillScanRootDirs(), [join(dir, "agent", "skills"), join(homedir(), ".agents", "skills")]);
    assert.deepEqual(getSkillScanRootDirs(cwd).slice(2), [
      join(cwd, ".pi", "skills"),
      join(cwd, ".agents", "skills"),
      // The walk stops at the git root.
      join(repo, ".agents", "skills"),
    ]);
  } finally {
    restore();
  }
});

test("discovery follows pi's directories, file rules and precedence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tau-skill-scan-"));
  const restore = withAgentDir(dir);
  try {
    const agentDir = join(dir, "agent");
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const cwd = join(repo, "pkg");
    // User: agent dir skills (a root .md counts in pi mode; a nested skill directory is found).
    write(join(agentDir, "skills", "kebab", "SKILL.md"), named("kebab", "disable-model-invocation: true\n"));
    write(join(agentDir, "skills", "loose.md"), "---\ndescription: Root file.\n---\n");
    write(join(agentDir, "skills", "group", "nested", "SKILL.md"), named("nested"));
    write(join(agentDir, "skills", "shared", "SKILL.md"), named("shared"));
    write(join(agentDir, "skills", "nodesc", "SKILL.md"), "---\nname: nodesc\n---\n");
    // A name falls back to the directory; the old omp keys hide nothing.
    write(join(agentDir, "skills", "from-dir", "SKILL.md"), "---\ndescription: No name.\nhide: true\n---\n");
    // Project: .pi/skills at cwd only, .agents/skills up to the git root (root .md files do not count there).
    write(join(cwd, ".pi", "skills", "shared", "SKILL.md"), named("shared"));
    write(join(repo, ".agents", "skills", "up", "SKILL.md"), named("up"));
    write(join(repo, ".agents", "skills", "root.md"), "---\ndescription: Not a skill here.\n---\n");
    write(join(dir, ".pi", "skills", "above", "SKILL.md"), named("above"));
    // settings.json `skills` entries.
    write(join(dir, "extra", "custom", "SKILL.md"), named("custom"));
    write(join(agentDir, "settings.json"), JSON.stringify({ skills: [join(dir, "extra")] }));
    // A package from `pi list`: its `pi.skills` manifest entry, and one using the skills/ convention.
    write(join(dir, "pkgs", "manifest", "package.json"), JSON.stringify({ pi: { skills: ["./res"] } }));
    write(join(dir, "pkgs", "manifest", "res", "m", "SKILL.md"), named("from-manifest"));
    write(join(dir, "pkgs", "manifest", "skills", "ignored", "SKILL.md"), named("ignored"));
    write(join(dir, "pkgs", "plain", "skills", "c", "SKILL.md"), named("from-convention"));
    write(join(dir, "list.txt"), ["User packages:", "  npm:manifest", `    ${join(dir, "pkgs", "manifest")}`, "  npm:plain", `    ${join(dir, "pkgs", "plain")}`, ""].join("\n"));
    const bin = writeStubPi(dir, [`cat '${join(dir, "list.txt")}'`], [`type "${join(dir, "list.txt")}"`]);

    const { skills } = await discoverSkills(cwd, bin);
    const byName = new Map(skills.map((s) => [s.name, s]));
    for (const name of ["kebab", "skills", "nested", "shared", "from-dir", "up", "custom", "from-manifest", "from-convention"]) {
      assert.ok(byName.has(name), `missing ${name}`);
    }
    for (const name of ["nodesc", "root", "above", "ignored"]) assert.equal(byName.has(name), false, `unexpected ${name}`);
    assert.equal(byName.get("skills").filePath, join(agentDir, "skills", "loose.md"));
    assert.equal(byName.get("kebab").disableModelInvocation, true);
    assert.equal(byName.get("from-dir").disableModelInvocation, false);
    // The project's skill wins a name collision.
    assert.deepEqual(byName.get("shared").sourceInfo, { source: ".pi", scope: "project" });
    assert.deepEqual(byName.get("from-manifest").sourceInfo, { source: "npm:manifest", scope: "user" });

    // The user level only: no project skills.
    const user = new Set((await discoverSkills(cwd, bin, "user")).skills.map((s) => s.name));
    assert.equal(user.has("up"), false);
    assert.equal(user.has("from-convention"), true);
    assert.deepEqual((await discoverSkills(cwd, bin, "user")).skills.find((s) => s.name === "shared").sourceInfo, { source: ".pi", scope: "user" });
  } finally {
    restore();
  }
});

test("`pi list` runs in cwd; a failure lists the other skills with a warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tau-skill-cli-"));
  const restore = withAgentDir(dir);
  try {
    // Shell metacharacters in the project name: it must never reach cmd.exe as an argument.
    const project = join(dir, "a b&echo pwned");
    write(join(project, ".pi", "skills", "local", "SKILL.md"), named("local"));
    const argsOut = join(dir, "args.txt");
    const cwdOut = join(dir, "cwd.txt");
    const bin = writeStubPi(
      dir,
      [`echo "$*" > '${argsOut}'`, `pwd -P > '${cwdOut}'`, "exit 1"],
      [`echo %*> "${argsOut}"`, `cd> "${cwdOut}"`, "exit /b 1"],
    );
    const { skills, diagnostics } = await discoverSkills(project, bin);
    assert.ok(skills.some((s) => s.name === "local"));
    assert.match(diagnostics.map((d) => d.message).join("\n"), /pi list failed/);
    assert.equal(readFileSync(argsOut, "utf8").trim(), "list");
    const ranIn = readFileSync(cwdOut, "utf8").trim();
    if (process.platform === "win32") assert.equal(ranIn.toLowerCase(), project.toLowerCase());
    else assert.equal(ranIn, realpathSync(project));
  } finally {
    restore();
  }
});

test("the user-level listing keeps a user skill whose directory is also a project's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tau-skill-user-"));
  const restore = withAgentDir(dir);
  try {
    write(join(dir, "agent", "skills", "mine", "SKILL.md"), named("mine"));
    // No pi binary: no package skills.
    const { skills } = await loadUserSkillsWithInstallInfo(null);
    assert.deepEqual(skills.find((skill) => skill.name === "mine")?.sourceInfo, { source: ".pi", scope: "user" });
  } finally {
    restore();
  }
});

test("only user-owned skills are togglable, and PATCH agrees", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tau-skill-patch-"));
  const restore = withAgentDir(dir);
  try {
    const owned = join(dir, "agent", "skills", "owned", "SKILL.md");
    const plugin = join(dir, "plugins", "pkg", "skills", "p", "SKILL.md");
    // A monorepo skill above the session dir: a project walk-up root.
    const pkg = join(dir, "mono", "pkg");
    const walkUp = join(dir, "mono", ".agents", "skills", "w", "SKILL.md");
    // The same layout under a directory tau never allowed.
    const strangerPkg = join(dir, "stranger", "pkg");
    const strangerWalkUp = join(dir, "stranger", ".agents", "skills", "s", "SKILL.md");
    write(owned, named("owned"));
    write(plugin, named("p"));
    write(walkUp, named("w"));
    write(strangerWalkUp, named("s"));
    mkdirSync(pkg, { recursive: true });
    mkdirSync(strangerPkg, { recursive: true });
    allowFileRoot(pkg);
    write(join(dir, "list.txt"), ["User packages:", "  npm:pkg", `    ${join(dir, "plugins", "pkg")}`, ""].join("\n"));
    const bin = writeStubPi(dir, [`cat '${join(dir, "list.txt")}'`], [`type "${join(dir, "list.txt")}"`]);

    const { skills } = await loadSkillsWithInstallInfo(pkg, bin);
    const togglable = Object.fromEntries(skills.map((s) => [s.name, s.togglable]));
    assert.deepEqual([togglable.owned, togglable.p, togglable.w], [true, false, true]);
    // getSkillToggleRoots must not leak scan roots into the shared cache.
    assert.equal(isExistingFilePathAllowed(walkUp, await getAllowedFileRoots()), false);

    const patch = (filePath, cwd) =>
      PATCH(new Request("http://localhost/api/skills", {
        method: "PATCH",
        body: JSON.stringify({ filePath, disableModelInvocation: true, ...(cwd && { cwd }) }),
      }));
    assert.equal((await patch(owned)).status, 200);
    assert.equal(flagOf(readFileSync(owned, "utf8")), true);
    assert.equal((await patch(plugin, pkg)).status, 403);
    assert.equal(readFileSync(plugin, "utf8"), named("p"));
    assert.equal((await patch(walkUp)).status, 403, "walk-up roots need the cwd");
    assert.equal((await patch(walkUp, pkg)).status, 200);
    assert.equal((await patch(strangerWalkUp, strangerPkg)).status, 403, "an unallowed cwd adds no roots");
    assert.equal(readFileSync(strangerWalkUp, "utf8"), named("s"));
  } finally {
    restore();
  }
});
