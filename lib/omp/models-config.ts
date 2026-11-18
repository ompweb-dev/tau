import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { getModelsConfigPath } from "./paths";
import { isRecord } from "../type-guards";

/**
 * Direct JSON access to pi's custom-models file (~/.pi/agent/models.json).
 * Unknown fields are preserved untouched.
 */

export interface ModelThinkingConfig {
  mode?: string;
  efforts?: string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
  [key: string]: unknown;
}

export interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinking?: ModelThinkingConfig;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  auth?: "apiKey" | "none" | "oauth";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ModelsFileConfig {
  providers?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

/** Mirrors validateProviderConfiguration(mode: "models-config") closely enough
 * to reject configs omp itself would refuse to load. Throws on failure. */
export function validateModelsConfig(config: ModelsFileConfig): void {
  if (!isRecord(config)) throw new Error("Config must be an object");
  config = sanitizeModelsConfig(config);
  const providers = config.providers ?? {};
  if (!isRecord(providers)) throw new Error('"providers" must be an object');
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) throw new Error(`Provider ${providerName}: must be an object`);
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (models.length > 0) {
      if (!provider.baseUrl) {
        throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
      }
      if (!provider.apiKey && (provider.auth ?? "apiKey") !== "none") {
        throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models unless auth is "none".`);
      }
    }
    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id) {
        throw new Error(`Provider ${providerName}: model missing "id"`);
      }
      if (!provider.api && !model.api) {
        throw new Error(`Provider ${providerName}, model ${model.id}: no "api" specified. Set at provider or model level.`);
      }
      if (typeof model.contextWindow === "number" && model.contextWindow <= 0) {
        throw new Error(`Provider ${providerName}, model ${model.id}: invalid contextWindow`);
      }
      if (typeof model.maxTokens === "number" && model.maxTokens <= 0) {
        throw new Error(`Provider ${providerName}, model ${model.id}: invalid maxTokens`);
      }
      // omp's schema requires all four cost fields whenever cost is present
      // (partial costs make omp reject the whole file), so refuse to write one.
      if (isRecord(model.cost)) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = model.cost[key];
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Provider ${providerName}, model ${model.id}: cost.${key} is required (cost needs input, output, cacheRead, and cacheWrite)`);
          }
        }
      }
    }
  }
}

/** Thrown when models.json exists but cannot be parsed. Overwriting such a file
 * would silently delete every provider the user hand-wrote, so writes refuse
 * unless the caller explicitly opts in. */
export class ModelsConfigParseError extends Error {
  readonly path: string;
  readonly detail: string;
  constructor(path: string, detail: string) {
    super(`${path} is not valid JSON: ${detail}`);
    this.name = "ModelsConfigParseError";
    this.path = path;
    this.detail = detail;
  }
}

export interface ModelsConfigFile {
  path: string;
  exists: boolean;
  /** Raw file text, kept so writes can merge into the original document. */
  source?: string;
  /** Empty when `parseError` is set — never write this back over the file. */
  config: ModelsFileConfig;
  parseError?: string;
}

/** Drop empty model rows produced by blank YAML sequence entries or an empty
 * `id`. Malformed non-empty rows are retained so validation can report them. */
function sanitizeModelsConfig(config: ModelsFileConfig): ModelsFileConfig {
  if (!isRecord(config.providers)) return config;
  const providers = Object.fromEntries(Object.entries(config.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));
  return { ...config, providers };
}

/** Read models.json, reporting rather than swallowing parse failures. */
export function readModelsConfigFile(): ModelsConfigFile {
  const path = getModelsConfigPath();
  if (!existsSync(path)) return { path, exists: false, config: { providers: {} } };

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return { path, exists: true, config: { providers: {} }, parseError: String(error) };
  }

  if (source.trim() === "") {
    return { path, exists: true, source, config: { providers: {} } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return {
      path,
      exists: true,
      source,
      config: { providers: {} },
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isRecord(parsed)) {
    return {
      path,
      exists: true,
      source,
      config: { providers: {} },
      parseError: "the top level of models.json must be a JSON object",
    };
  }
  return { path, exists: true, source, config: sanitizeModelsConfig(parsed as ModelsFileConfig) };
}

/** Tolerant read for consumers that only inspect the config (a broken file
 * reads as empty). Anything that writes the file back must go through
 * readModelsConfigFile()/writeModelsConfig() so a parse error blocks the write. */
export function readModelsConfig(): ModelsFileConfig {
  return readModelsConfigFile().config;
}

/** Serialize a config as formatted JSON. */
export function serializeModelsConfig(config: ModelsFileConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export interface WriteModelsConfigOptions {
  /** Replace an unparseable models.yml instead of refusing — destroys whatever
   * the user has in the file, so only pass it on an explicit user request. */
  overwriteUnparseable?: boolean;
}

export function writeModelsConfig(config: ModelsFileConfig, options: WriteModelsConfigOptions = {}): void {
  const current = readModelsConfigFile();
  if (current.parseError && !options.overwriteUnparseable) {
    throw new ModelsConfigParseError(current.path, current.parseError);
  }
  const text = serializeModelsConfig(sanitizeModelsConfig(config));
  const dir = dirname(current.path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Write-then-rename: a crash mid-write must not leave models.yml truncated,
  // which would disable every custom model until the user repairs it by hand.
  const temp = join(dir, `.${basename(current.path)}.omp-web-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, current.path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
