/**
 * Thinking-level resolution for the CURRENT model in the composer.
 *
 * `/api/models` carries each pickable model's ladder, computed from pi's
 * `reasoning` and `thinkingLevelMap` as pi-ai's getSupportedThinkingLevels does. A running session's `get_state` resolves the model
 * pi is ACTUALLY using — which can differ from the session file's model
 * entry (a disabled/renamed provider falls back to the default model, and the
 * catalog only lists enabled providers). When the catalog misses the current
 * model, the live metadata is the authoritative fallback, so the dropdown
 * never falls back to the generic ladder and lists unsupported efforts.
 */

/** Model-level thinking metadata read off the live session state. */
export interface ThinkingModelMeta {
  provider: string;
  modelId: string;
  name?: string;
  reasoning?: boolean;
  /** pi's per-level wire value; null marks a level unsupported. */
  thinkingLevelMap?: Record<string, string | null>;
}

export const DEFAULT_THINKING_LEVELS: readonly string[] = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Keep familiar levels ordered while preserving provider-defined additions. */
export function selectableThinkingLevels(available: readonly string[] | null | undefined): string[] {
  if (!available) return [...DEFAULT_THINKING_LEVELS];

  const remaining = new Set(available.filter((level) => level && level !== "auto"));
  const ordered = DEFAULT_THINKING_LEVELS.filter((level) => level === "auto" || remaining.delete(level));
  return [...ordered, ...remaining];
}

/** pi-ai's getSupportedThinkingLevels: unmapped levels are supported through high; xhigh and max only when mapped. */
export function thinkingLevelsForMeta(meta: Pick<ThinkingModelMeta, "reasoning" | "thinkingLevelMap">): string[] {
  if (!meta.reasoning) return ["off"];
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => {
    const mapped = meta.thinkingLevelMap?.[level];
    return mapped !== null && (mapped !== undefined || (level !== "xhigh" && level !== "max"));
  });
}

/**
 * Levels offered for the current model: the catalog's baked ladder wins; the
 * live session model backs non-catalog models. Returns null when neither
 * source knows the model — callers then fall back to the generic ladder.
 */
export function resolveAvailableThinkingLevels(
  catalogLevels: string[] | undefined,
  model: { provider: string; modelId: string } | null,
  liveModel: ThinkingModelMeta | null,
): string[] | null {
  if (catalogLevels && catalogLevels.length > 0) return catalogLevels;
  if (model && liveModel && liveModel.provider === model.provider && liveModel.modelId === model.modelId) {
    return thinkingLevelsForMeta(liveModel);
  }
  return null;
}
