// Preloaded by every test process (bunfig.toml [test]): os.tmpdir() points into a directory of this process's own, so
// state a test writes after it restored the environment (a body still running past its timeout, a late timer) lands
// there and not in the machine's real temp directory, where a running server would read it (the self-update root
// `<tmp>/tau-self-update-<uid>`). Removed once the file's tests end.
import { afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "t-"));
// Like /tmp: tests that drop to another user (file-access.permissions) still need to reach their fixtures.
chmodSync(root, 0o1777);
for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
