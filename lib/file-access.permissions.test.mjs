import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeBinary, repo } from "./hosts/update-fixture.test-helper.mjs";

// pi's agent dir may be traversable yet unlistable (mode 0111): readdir then
// hides credential copies such as models.json-backup. Fixed names stay denied,
// and unknown aliases stay unknown until the listing is readable again. Needs a real child process + real EACCES, so
// the policy modules load in the child and, when root, the child drops to
// nobody AFTER importing them (the checkout is not traversable by nobody).
const CHILD = `
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const f = JSON.parse(process.env.FIXTURE);
(async () => {
  const access = await import(path.join(f.repo, "lib", "file-access.ts"));
  const authorization = await import(path.join(f.repo, "lib", "file-authorization.ts"));
  process.chdir(f.root);
  if (process.getuid() === 0) { process.setgroups([]); process.setgid(65534); process.setuid(65534); }
  // Fixture honesty: setup failures exit nonzero, distinct from policy answers.
  assert.notEqual(process.getuid(), 0, "SETUP: still root");
  if (f.unreadable) assert.throws(() => fs.readdirSync(f.agentDir), { code: "EACCES" }, "SETUP: agent dir must be unlistable");
  else fs.readdirSync(f.agentDir);
  assert.equal(fs.readFileSync(f.auth, "utf8"), "auth\\n", "SETUP: auth.json must stay readable");
  assert.equal(fs.realpathSync.native(f.authLink), f.auth, "SETUP: link must resolve to auth.json");
  assert.equal(fs.realpathSync.native(f.externalLink), f.externalCopy, "SETUP: off-tree copy alias must resolve");
  assert.equal(fs.readFileSync(f.independent[0], "utf8"), "independent\\n", "SETUP: independent file must be readable");
  const roots = new Set([f.workspace, ...access.getConfigAgentRoots()]);
  const decide = async (file) => {
    try {
      const decision = await authorization.authorizeFileAccess(file.split("/").filter(Boolean), null, false, roots);
      return { secret: access.isPiSecretFile(file), ok: decision.ok, status: decision.ok ? 200 : decision.status };
    } catch (error) {
      return { ok: false, status: error.status, code: error.code };
    }
  };
  const result = { direct: await decide(f.auth), link: await decide(f.authLink), external: await decide(f.externalLink), independent: [] };
  for (const file of f.independent) result.independent.push(await decide(file));
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error); process.exit(1); });
`;

test("an unlistable agent dir refuses unknown aliases until it becomes readable", { skip: process.platform === "win32" && "POSIX mode bits are not enforced on Windows" }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tau-agent-listing-")));
  const home = path.join(root, "home");
  const config = path.join(home, ".pi");
  const agentDir = path.join(config, "agent");
  const workspace = path.join(root, "workspace");
  const auth = path.join(agentDir, "auth.json");
  const authLink = path.join(workspace, "linked-auth.txt");
  const independent = [path.join(workspace, "auth.json"), path.join(workspace, "models.json-backup")];
  const external = path.join(workspace, "off-tree");
  const externalCopy = path.join(external, "copy.txt");
  const externalLink = path.join(workspace, "linked-off-tree.txt");
  t.after(() => {
    // Restore listing so a non-root parent can remove the fixture.
    if (fs.existsSync(agentDir)) fs.chmodSync(agentDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const dir of [root, home, config, agentDir, workspace, external]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
  }
  fs.writeFileSync(auth, "auth\n", { mode: 0o644 });
  for (const file of independent) fs.writeFileSync(file, "independent\n", { mode: 0o644 });
  fs.symlinkSync(auth, authLink);
  fs.writeFileSync(externalCopy, "credential copy\n", { mode: 0o644 });
  fs.symlinkSync(externalCopy, path.join(agentDir, "models.json-backup"));
  fs.symlinkSync(externalCopy, externalLink);
  fs.chmodSync(agentDir, 0o111);

  const decide = (unreadable) => {
    const child = spawnSync(runtimeBinary(), ["-e", CHILD], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        FIXTURE: JSON.stringify({ repo, root, agentDir, auth, authLink, workspace, independent, externalCopy, externalLink, unreadable }),
      },
    });
    assert.equal(child.status, 0, `child exited ${child.status} signal ${child.signal}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    return JSON.parse(child.stdout.trim().split("\n").pop());
  };
  const unavailable = { ok: false, status: 503, code: "credential_policy_unavailable" };
  const blocked = decide(true);
  assert.deepEqual(blocked.direct, { secret: true, ok: false, status: 403 }, "direct auth.json");
  assert.deepEqual(blocked.link, { secret: true, ok: false, status: 403 }, "workspace symlink to auth.json");
  assert.deepEqual(blocked.external, unavailable, "unknown off-tree copy aliases cannot be declared safe");
  assert.deepEqual(blocked.independent, independent.map(() => unavailable), "unknown ownership is unavailable, not an invented file restriction");
  fs.chmodSync(agentDir, 0o755);
  const readable = decide(false);
  assert.deepEqual(readable.external, { secret: true, ok: false, status: 403 }, "listed off-tree copy aliases remain private");
  assert.deepEqual(readable.independent, independent.map(() => ({ secret: false, ok: true, status: 200 })), "independent files work once metadata is readable");
  assert.equal(fs.readFileSync(auth, "utf8"), "auth\n");
});

// pi's credential store may be a symlink into a directory this process cannot
// traverse. A hardlink to the same inode in an allowed workspace stays readable,
// but realpath of the configured auth.json throws EACCES, so the policy cannot
// learn the canonical credential target. That is "unknown", never "safe".
const VAULT_CHILD = `
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const f = JSON.parse(process.env.FIXTURE);
(async () => {
  const access = await import(path.join(f.repo, "lib", "file-access.ts"));
  const authorization = await import(path.join(f.repo, "lib", "file-authorization.ts"));
  process.chdir(f.root);
  if (process.getuid() === 0) { process.setgroups([]); process.setgid(65534); process.setuid(65534); }
  // Fixture honesty: setup failures exit nonzero, distinct from policy answers.
  assert.notEqual(process.getuid(), 0, "SETUP: still root");
  assert.ok(fs.readdirSync(f.agentDir).includes("auth.json"), "SETUP: active agent dir must be readable");
  assert.equal(fs.readFileSync(f.alias, "utf8"), f.keys, "SETUP: workspace hardlink must stay readable");
  assert.equal(fs.statSync(f.alias).nlink, 2, "SETUP: alias must be a hardlink to the vault file");
  assert.equal(fs.readFileSync(f.independent, "utf8"), "independent\\n", "SETUP: independent file must be readable");
  if (f.locked) {
    assert.throws(() => fs.realpathSync.native(f.agentDb), { code: "EACCES" }, "SETUP: configured auth.json realpath must fail with EACCES");
    assert.throws(() => fs.statSync(f.agentDb), { code: "EACCES" }, "SETUP: configured auth.json must be unreachable by path");
  } else {
    assert.equal(fs.realpathSync.native(f.agentDb), f.vault, "SETUP: configured auth.json must resolve once restored");
  }
  const roots = new Set([f.workspace, ...access.getConfigAgentRoots()]);
  const decide = async (file) => {
    try {
      const decision = await authorization.authorizeFileAccess(file.split("/").filter(Boolean), null, false, roots);
      return { secret: access.isPiSecretFile(file), ok: decision.ok, status: decision.ok ? 200 : decision.status };
    } catch (error) {
      return { ok: false, status: error.status, code: error.code };
    }
  };
  console.log(JSON.stringify({ alias: await decide(f.alias), independent: await decide(f.independent) }));
})().catch((error) => { console.error(error); process.exit(1); });
`;

test("an auth.json symlink into an untraversable directory fails closed instead of leaking a hardlink alias", { skip: process.platform === "win32" && "POSIX mode bits are not enforced on Windows" }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tau-locked-vault-")));
  const home = path.join(root, "home");
  const config = path.join(home, ".pi");
  const agentDir = path.join(config, "agent");
  const agentDb = path.join(agentDir, "auth.json");
  const workspace = path.join(root, "workspace");
  const lockedVault = path.join(root, "locked-vault");
  const vault = path.join(lockedVault, "vault.sqlite");
  const alias = path.join(workspace, "vault-alias.sqlite");
  const independent = path.join(workspace, "notes.txt");
  const keys = "fixture-key-aaaa\nfixture-key-bbbb\n";
  t.after(() => {
    // Restore traversal so a non-root parent can remove the fixture.
    if (fs.existsSync(lockedVault)) fs.chmodSync(lockedVault, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const dir of [root, home, config, agentDir, workspace, lockedVault]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
  }
  fs.writeFileSync(vault, keys, { mode: 0o644 });
  fs.linkSync(vault, alias);
  fs.writeFileSync(independent, "independent\n", { mode: 0o644 });
  fs.symlinkSync(vault, agentDb);
  fs.chmodSync(lockedVault, 0o000);

  const decide = (locked) => {
    const child = spawnSync(runtimeBinary(), ["-e", VAULT_CHILD], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        FIXTURE: JSON.stringify({ repo, root, agentDir, agentDb, workspace, vault, alias, independent, keys, locked }),
      },
    });
    assert.equal(child.status, 0, `child exited ${child.status} signal ${child.signal}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    return JSON.parse(child.stdout.trim().split("\n").pop());
  };
  const unavailable = { ok: false, status: 503, code: "credential_policy_unavailable" };
  const blocked = decide(true);
  assert.deepEqual(blocked.alias, unavailable, "hardlink alias of a credential target that cannot be canonicalized");
  assert.deepEqual(blocked.independent, unavailable, "unknown ordinary request while credential metadata is opaque");
  fs.chmodSync(lockedVault, 0o755);
  const readable = decide(false);
  assert.deepEqual(readable.alias, { secret: true, ok: false, status: 403 }, "hardlink alias once the target is canonical");
  assert.deepEqual(readable.independent, { secret: false, ok: true, status: 200 }, "independent file once metadata is readable");
  assert.equal(fs.readFileSync(vault, "utf8"), keys);
});
