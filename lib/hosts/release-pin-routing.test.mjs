import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "release-pin-routing-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { releaseRepo } = await import("../release-repo.ts");
const hub = await import("./hub.ts");
const { linkHost } = await import("./link-driver.test-helper.mjs");
const { LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
const pin = { version: "0.8.0", releaseRepo: releaseRepo(), assets: { "tau-linux-x64.tar.gz": "a".repeat(64) } };
const operationId = "12345678-1234-4234-8234-123456789012";
test.after(() => {
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("a proven native pin consumer evaluates approved A instead of moving latest B", async (t) => {
  const link = await linkHost("Native pin consumer");
  let checked, received;
  const serving = link.serve({
    checkUpdates: (args) => {
      checked = args;
      return { tau: { currentVersion: "0.7.1", availableVersion: args.releasePin?.version ?? "0.9.0", updateAvailable: true,
        canUpdate: true, supportsReleasePin: true, supportsTwoPhaseUpdate: true, canForceUpdate: true, forceMethod: "native", blockers: [],
        blockedReason: null, updateCommand: "", installMethod: "binary", protocolVersion: LINK_PROTOCOL_VERSION },
        omp: { currentVersion: null }, operation: null };
    },
    updateSoftware: (args) => { received = args; return { accepted: true, operation: { id: args.operationId, target: "tau", version: args.version, state: "running" } }; },
    open: () => { throw new Error("A proven native consumer must not open a recovery runner"); },
  });
  t.after(async () => { hub.closeHostLink(link.id); await serving; });
  await hub.updateHostSoftware(link.id, "tau", pin.version, { releasePin: pin, requireReleasePin: true, operationId });
  assert.deepEqual(checked.releasePin, pin);
  assert.deepEqual(received.releasePin, pin);
  assert.equal(received.requireReleasePin, true);
});
