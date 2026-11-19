// Shared models.json types, constants, and pure helpers extracted from
// ModelsConfig.tsx (pure extraction, no behavior change).

export type IconComponent = React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>;

// Provider glyphs are derived from the provider id. Provider ids come from
// pi's models.json at runtime, so adding one never requires a UI registry entry.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
}

export interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  modelCount: number;
  /** pi can store a key for it (`/api/auth/api-key/[provider]`). */
  apiKeyLogin?: boolean;
  /** The credential type stored in the host's auth.json, if any. */
  stored?: "api_key" | "oauth" | null;
}

export type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

// pi's `thinkingLevelMap`: the value sent for a level, null when the model does not support it; an absent level
// keeps pi's default (supported through high; xhigh and max unsupported).
export type ThinkingLevelMap = Record<string, string | null>;

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  auth?: "apiKey" | "none" | "oauth";
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

export interface ModelsFileData {
  providers?: Record<string, ProviderEntry>;
}

export type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

export type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string }
  | { type: "picker" }
  | { type: "registry" }
  | { type: "fallbacks" };
export interface RuntimeModelEntry {
  id: string;
  name: string;
  provider: string;
  thinkingLevels?: string[];
}

export interface ConnectedProvider {
  id: string;
  name: string;
}

export type NativeRegistrySettings = {
  enabledModels?: string[];
};

export type RetrySettings = {
  retry?: { enabled?: boolean; maxRetries?: number };
};
export const COMPOSER_MODELS_STORAGE_KEY = "tau-composer-models";
// APIs a models.json provider or model can name.
export const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
] as const;
export const hoverRow = (selected: boolean) => ({
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { if (!selected) e.currentTarget.style.background = "var(--bg-hover)"; },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { if (!selected) e.currentTarget.style.background = "none"; },
});

export const hoverAccent = {
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; },
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border)"; },
};
export type EndpointPreset = {
  label: string;
  baseUrl: string;
  /** "none" forces no-auth; "apiKey" forces key-based auth; "keep" preserves the current auth mode. */
  auth: "none" | "apiKey" | "keep";
};

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  { label: "🦙 Ollama", baseUrl: "http://localhost:11434/v1", auth: "none" },
  { label: "⚡ LM Studio / vLLM", baseUrl: "http://localhost:1234/v1", auth: "none" },
  { label: "🌐 OpenRouter", baseUrl: "https://openrouter.ai/api/v1", auth: "apiKey" },
  { label: "🤖 Local Proxy (:2455)", baseUrl: "http://127.0.0.1:2455/v1", auth: "keep" },
];

export const presetButtonStyle = {
  padding: "4px 8px",
  fontSize: 11,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
} as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off:     "var(--text-dim)",
  minimal: "var(--text-dim)",
  low:     "color-mix(in srgb, var(--accent) 45%, var(--text-muted))",
  medium:  "var(--accent)",
  high:    "var(--accent-hover)",
  xhigh:   "var(--status-warning)",
  max:     "var(--status-error)",
};
export const COST_LABEL_KEYS = {
  input: "modelsConfig.costInput",
  output: "modelsConfig.costOutput",
  cacheRead: "modelsConfig.costCacheRead",
  cacheWrite: "modelsConfig.costCacheWrite",
} as const;
// ── Provider icon ─────────────────────────────────────────────────────────────

export function providerInitials(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";
}
