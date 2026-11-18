import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  ModelsConfigParseError,
  readModelsConfigFile,
  serializeModelsConfig,
  validateModelsConfig,
  writeModelsConfig,
} = await import("./models-config.ts");

const SAMPLE_CONFIG = {
  providers: {
    "local-llama": {
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "LLAMA_API_KEY",
      api: "openai-completions",
      models: [
        { id: "llama-3.3-70b", name: "Llama 3.3 70B", contextWindow: 131072, maxTokens: 8192 },
        { id: "llama-3.2-3b", name: "Llama 3.2 3B", contextWindow: 32768 },
      ],
    },
    "work-proxy": {
      baseUrl: "https://proxy.internal/v1",
      apiKey: "!op read op://work/openai/key",
      api: "openai-responses",
      models: [{ id: "gpt-5", reasoning: true }],
    },
  },
};

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-models-config-"));
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    xdg: process.env.XDG_DATA_HOME,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.XDG_DATA_HOME;
  try {
    run(dir, join(dir, "models.json"));
  } finally {
    for (const [key, value] of [
      ["PI_CODING_AGENT_DIR", previous.agentDir],
      ["XDG_DATA_HOME", previous.xdg],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("round-trips models.json edits cleanly", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(SAMPLE_CONFIG, null, 2), "utf8");

    const file = readModelsConfigFile();
    assert.equal(file.parseError, undefined);
    assert.deepEqual(Object.keys(file.config.providers), ["local-llama", "work-proxy"]);

    file.config.providers["local-llama"].models[0].maxTokens = 16384;
    writeModelsConfig(file.config);

    const reread = readModelsConfigFile();
    assert.equal(reread.config.providers["local-llama"].models[0].maxTokens, 16384);
    assert.equal(reread.config.providers["work-proxy"].apiKey, "!op read op://work/openai/key");
  });
});

test("adds and removes providers", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(SAMPLE_CONFIG, null, 2), "utf8");

    const { config } = readModelsConfigFile();
    delete config.providers["work-proxy"];
    config.providers["new-provider"] = {
      baseUrl: "https://example.invalid/v1",
      apiKey: "EXAMPLE_KEY",
      api: "openai-completions",
      models: [{ id: "example-1", contextWindow: 8000 }],
    };
    writeModelsConfig(config);

    const reread = readModelsConfigFile();
    assert.deepEqual(Object.keys(reread.config.providers), ["local-llama", "new-provider"]);
  });
});

test("reports a parse error instead of an empty config", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "{ invalid json", "utf8");

    const file = readModelsConfigFile();
    assert.equal(file.exists, true);
    assert.ok(file.parseError);
    assert.deepEqual(file.config, { providers: {} });
  });
});

test("refuses to overwrite an unparseable models.json unless overwriteUnparseable is true", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "{ broken", "utf8");

    assert.throws(
      () => writeModelsConfig({ providers: {} }),
      (error) => error instanceof ModelsConfigParseError && error.path === path,
    );
    assert.equal(readFileSync(path, "utf8"), "{ broken");

    writeModelsConfig({ providers: {} }, { overwriteUnparseable: true });
    assert.equal(readModelsConfigFile().parseError, undefined);
  });
});

test("treats a non-object models.json as unparseable", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '["a", "b"]', "utf8");

    const file = readModelsConfigFile();
    assert.match(file.parseError, /JSON object/);
  });
});

test("writes a fresh file when none exists", () => {
  withAgentDir(() => {
    writeModelsConfig({
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          auth: "none",
          api: "openai-completions",
          models: [{ id: "qwen3:8b" }],
        },
      },
    });
    assert.equal(readModelsConfigFile().config.providers.ollama.models[0].id, "qwen3:8b");
    assert.doesNotMatch(serializeModelsConfig({ providers: {} }), /undefined/);
  });
});

test("ignores blank model rows while preserving non-empty rows", () => {
  withAgentDir((dir, path) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({
      providers: {
        p: {
          models: [{ id: "" }, { id: "   " }, { id: "valid" }],
        },
      },
    }), "utf8");

    const file = readModelsConfigFile();
    assert.deepEqual(file.config.providers.p.models.map((model) => model.id), ["valid"]);
    assert.doesNotThrow(() => validateModelsConfig({
      providers: { p: { baseUrl: "http://localhost/v1", apiKey: "k", api: "openai-completions", models: [{ id: "" }, { id: "valid" }] } },
    }));
  });
});
