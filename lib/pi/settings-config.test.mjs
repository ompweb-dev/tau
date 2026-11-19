import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { readNativeSettings, writeNativeSettings } = await import("./settings-config.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "tau-settings-config-"));
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

test("reads and writes pi's settings.json keys while preserving unknown keys", () => {
  withAgentDir((dir) => {
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ customKey: "keep-me", compaction: { reserveTokens: 9000 }, retry: { baseDelayMs: 500 } }), "utf8");
    assert.equal(readNativeSettings().path, file);

    writeNativeSettings({ hideThinkingBlock: true, defaultThinkingLevel: "off", enabledModels: ["a/b"], retry: { enabled: false, maxRetries: 5 }, compaction: { enabled: false, keepRecentTokens: 30_000 } });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(saved, {
      customKey: "keep-me", hideThinkingBlock: true, defaultThinkingLevel: "off", enabledModels: ["a/b"],
      retry: { baseDelayMs: 500, enabled: false, maxRetries: 5 },
      compaction: { reserveTokens: 9000, enabled: false, keepRecentTokens: 30_000 },
    });
    assert.deepEqual(readNativeSettings().settings, {
      defaultThinkingLevel: "off", hideThinkingBlock: true, enabledModels: ["a/b"],
      retry: { enabled: false, maxRetries: 5 }, compaction: { enabled: false, keepRecentTokens: 30_000 },
    });
  });
});

test("omp-only keys are neither read nor written", () => {
  withAgentDir((dir) => {
    const file = join(dir, "settings.json");
    const omp = { defaultThinkingLevel: "auto", tools: { approval: { bash: "deny" } }, retry: { modelFallback: true }, compaction: { methodOrder: ["soft"] }, disabledProviders: ["x"] };
    writeFileSync(file, JSON.stringify(omp), "utf8");
    assert.deepEqual(readNativeSettings().settings, {});
    writeNativeSettings({ tools: { approval: { bash: "allow" } }, personality: "friendly" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), omp);
  });
});

test("invalid values are rejected before the file is touched", () => {
  withAgentDir((dir) => {
    const file = join(dir, "settings.json");
    writeFileSync(file, "{}", "utf8");
    for (const settings of [
      { defaultThinkingLevel: "auto" }, { hideThinkingBlock: "yes" }, { retry: { maxRetries: 99 } }, { retry: { enabled: 1 } },
      { compaction: { keepRecentTokens: 10 } }, { enabledModels: [""] }, { retry: [] },
    ]) {
      assert.throws(() => writeNativeSettings(settings));
      assert.equal(readFileSync(file, "utf8"), "{}");
    }
  });
});
