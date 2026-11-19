import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getSettingsPath } from "./paths";
import { isRecord } from "../type-guards";

/** The settings Settings edits in pi's global settings.json, under pi's own keys (dist/core/settings-schema). */
export type NativeSettings = {
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  hideThinkingBlock?: boolean;
  enabledModels?: string[];
  retry?: { enabled?: boolean; maxRetries?: number };
  compaction?: { enabled?: boolean; keepRecentTokens?: number };
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function configPath(): string {
  return getSettingsPath();
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function assertOptionalRecord(value: unknown, name: string): asserts value is Record<string, unknown> | undefined {
  if (value !== undefined && !isRecord(value)) throw new Error(`${name} must be an object`);
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}

function readJsonObject(): { path: string; data: Record<string, unknown> } {
  const path = configPath();
  if (!existsSync(path)) return { path, data: {} };
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return { path, data: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return { path, data: parsed };
}

/** Returns the persisted values only; omitted keys keep pi's defaults. */
export function readNativeSettings(): { path: string; settings: NativeSettings } {
  const { path, data } = readJsonObject();
  const retry = isRecord(data.retry) ? data.retry : {};
  const compaction = isRecord(data.compaction) ? data.compaction : {};
  const integer = (value: unknown) => typeof value === "number" && Number.isInteger(value);
  return {
    path,
    settings: {
      ...(THINKING_LEVELS.has(data.defaultThinkingLevel as string) ? { defaultThinkingLevel: data.defaultThinkingLevel as NativeSettings["defaultThinkingLevel"] } : {}),
      ...(typeof data.hideThinkingBlock === "boolean" ? { hideThinkingBlock: data.hideThinkingBlock } : {}),
      ...(stringArray(data.enabledModels) ? { enabledModels: stringArray(data.enabledModels) } : {}),
      ...(typeof retry.enabled === "boolean" || integer(retry.maxRetries) ? { retry: {
        ...(typeof retry.enabled === "boolean" ? { enabled: retry.enabled } : {}),
        ...(integer(retry.maxRetries) ? { maxRetries: retry.maxRetries as number } : {}),
      } } : {}),
      ...(typeof compaction.enabled === "boolean" || integer(compaction.keepRecentTokens) ? { compaction: {
        ...(typeof compaction.enabled === "boolean" ? { enabled: compaction.enabled } : {}),
        ...(integer(compaction.keepRecentTokens) ? { keepRecentTokens: compaction.keepRecentTokens as number } : {}),
      } } : {}),
    },
  };
}

/** Validates and applies those settings, keeping every other key of the file. */
export function writeNativeSettings(settings: NativeSettings): void {
  if (!isRecord(settings)) throw new Error("Settings must be an object");
  assertOptionalRecord(settings.retry, "retry");
  assertOptionalRecord(settings.compaction, "compaction");
  for (const [name, value] of Object.entries({
    hideThinkingBlock: settings.hideThinkingBlock,
    "retry.enabled": settings.retry?.enabled,
    "compaction.enabled": settings.compaction?.enabled,
  })) assertOptionalBoolean(value, name);
  if (settings.defaultThinkingLevel !== undefined && !THINKING_LEVELS.has(settings.defaultThinkingLevel)) throw new Error("Invalid default thinking level");
  if (settings.retry?.maxRetries !== undefined && (!Number.isInteger(settings.retry.maxRetries) || settings.retry.maxRetries < 0 || settings.retry.maxRetries > 20)) throw new Error("Retry attempts must be an integer between 0 and 20");
  if (settings.compaction?.keepRecentTokens !== undefined && (!Number.isInteger(settings.compaction.keepRecentTokens) || settings.compaction.keepRecentTokens < 1_000 || settings.compaction.keepRecentTokens > 1_000_000)) throw new Error("Compaction retained tokens must be an integer between 1,000 and 1,000,000");
  if (settings.enabledModels !== undefined && (!Array.isArray(settings.enabledModels) || settings.enabledModels.some((value) => typeof value !== "string" || !value.trim()))) throw new Error("enabledModels must contain non-empty strings");

  const { path, data } = readJsonObject();
  mkdirSync(dirname(path), { recursive: true });
  const mergeSection = (key: string, patch?: Record<string, unknown>) => {
    if (!patch || Object.keys(patch).length === 0) return;
    const existing = isRecord(data[key]) ? { ...data[key] } : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) existing[k] = v;
    }
    data[key] = existing;
  };
  if (settings.defaultThinkingLevel !== undefined) data.defaultThinkingLevel = settings.defaultThinkingLevel;
  if (settings.hideThinkingBlock !== undefined) data.hideThinkingBlock = settings.hideThinkingBlock;
  if (settings.enabledModels !== undefined) data.enabledModels = settings.enabledModels;
  mergeSection("retry", settings.retry);
  mergeSection("compaction", settings.compaction);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}
