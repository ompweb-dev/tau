import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { readNativeSettings, writeNativeSettings } = await import("./settings-config.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reads and writes settings.json while preserving unknown keys", () => {
  withAgentDir((dir) => {
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ customKey: "keep-me", compaction: { methodOrder: ["soft"] } }), "utf8");
    assert.equal(readNativeSettings().path, file);
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["soft"]);

    writeNativeSettings({ hideThinkingBlock: true });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.customKey, "keep-me");
    assert.equal(saved.hideThinkingBlock, true);
  });
});

test("validates compaction.methodOrder and replaces the whole persisted order", () => {
  withAgentDir((dir) => {
    assert.throws(() => writeNativeSettings({ mcp: { notifications: "yes" } }), /mcp.notifications must be a boolean/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["prune"] } }), /Invalid compaction method order/);
    assert.throws(() => writeNativeSettings({ compaction: { methodOrder: ["soft", "soft"] } }), /Invalid compaction method order/);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { methodOrder: ["remote", "snapcompact", "handoff", "shake", "soft"] } }), "utf8");
    writeNativeSettings({ compaction: { methodOrder: ["shake", "remote"], autoContinue: true } });
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, ["shake", "remote"]);
    writeNativeSettings({ compaction: { methodOrder: [] } });
    assert.deepEqual(readNativeSettings().settings.compaction.methodOrder, []);
  });
});

test("reads the method order pi/tau will run, including legacy strategy keys", () => {
  withAgentDir((dir) => {
    const read = (obj) => {
      writeFileSync(join(dir, "settings.json"), JSON.stringify(obj), "utf8");
      return readNativeSettings().settings.compaction?.methodOrder;
    };
    assert.deepEqual(read({ compaction: { methodOrder: ["soft", "future", "shake", "soft"] } }), ["soft", "shake"]);
    assert.deepEqual(read({ compaction: { methodOrder: ["handoff"], strategy: "off" } }), ["handoff"]);
    assert.deepEqual(read({ compaction: { strategy: "off" } }), []);
    assert.deepEqual(read({ compaction: { strategy: "handoff" } }), ["handoff", "remote", "soft"]);
    assert.deepEqual(read({ compaction: { strategy: "context-full", remoteEnabled: false } }), ["soft"]);
    assert.deepEqual(read({ compaction: { remoteEnabled: false } }), ["snapcompact", "handoff", "shake", "soft"]);
    assert.equal(read({ compaction: { enabled: true } }), undefined);
    assert.deepEqual(read({ "compaction.methodOrder": [] }), []);
    assert.deepEqual(read({ "compaction.strategy": "off", compaction: { strategy: "shake" } }), ["shake", "remote", "soft"]);
  });
});
test("persists and reads the externalThinking setting (v17.2.14+)", () => {
  withAgentDir(() => {
    assert.throws(() => writeNativeSettings({ externalThinking: "yes" }), /externalThinking must be a boolean/);
    writeNativeSettings({ externalThinking: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    // Writes are incremental: an unrelated later write preserves the key.
    writeNativeSettings({ hideThinkingBlock: true });
    assert.equal(readNativeSettings().settings.externalThinking, true);
    assert.equal(readNativeSettings().settings.hideThinkingBlock, true);
  });
});
test("persists and validates retry settings", () => {
  withAgentDir(() => {
    writeNativeSettings({ retry: { enabled: false, maxRetries: 3, modelFallback: true } });
    const settings = readNativeSettings().settings.retry;
    assert.equal(settings?.enabled, false);
    assert.equal(settings?.maxRetries, 3);
    assert.equal(settings?.modelFallback, true);
    assert.throws(() => writeNativeSettings({ retry: { maxRetries: 99 } }), /Retry attempts must be an integer between 0 and 20/);
  });
});
test("persists and validates tool approval policies", () => {
  withAgentDir(() => {
    writeNativeSettings({ tools: { approval: { bash: "deny", extension: "allow" } } });
    const settings = readNativeSettings().settings;
    assert.equal(settings.tools.approval.bash, "deny");
    assert.equal(settings.tools.approval.extension, "allow");
    assert.throws(() => writeNativeSettings({ tools: { approval: { bash: "bogus" } } }), /Invalid Bash approval policy/);
    assert.throws(() => writeNativeSettings({ tools: { approval: { extension: "deny" } } }), /Invalid extension tool approval policy/);
  });
});

test("changing Auto source preserves other provider settings and accepts explicit classifier", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "# keep me\nproviders:\n  autoThinkingMaxEffort: max\n  unrelated: retained\n", "utf8");
    writeNativeSettings({ providers: { autoThinkingSource: "vendor" } });
    assert.equal(readNativeSettings().settings.providers?.autoThinkingSource, "vendor");
    assert.match(readFileSync(path, "utf8"), /autoThinkingMaxEffort: max/);
    assert.match(readFileSync(path, "utf8"), /unrelated: retained/);
    assert.match(readFileSync(path, "utf8"), /# keep me/);
    writeNativeSettings({ providers: { autoThinkingSource: "classifier" } });
    assert.equal(readNativeSettings().settings.providers?.autoThinkingSource, "classifier");
  });
});

test("unknown persisted Auto sources are not offered as a supported choice", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), "providers:\n  autoThinkingSource: future\n", "utf8");
    assert.equal(readNativeSettings().settings.providers, undefined);
  });
});

test("invalid Auto source input is rejected before touching config", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "defaultThinkingLevel: high\n", "utf8");
    for (const providers of ["vendor", { autoThinkingSource: "future" }, { autoThinkingSource: null }]) {
      assert.throws(() => writeNativeSettings({ providers }));
      assert.equal(readFileSync(path, "utf8"), "defaultThinkingLevel: high\n");
    }
  });
});

