"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { manifestHref, THEME_COLOR_COOKIE } from "@/lib/manifest-theme";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export type ThemeDefinition = {
  id: Theme;
  name: string;
  mode: "light" | "dark";
  bg: string;
  /** `--bg-panel`, the top bar's color: browser and Android system bars blend into it. */
  panel: string;
  accent: string;
};

export const LIGHT_THEMES: ReadonlyArray<ThemeDefinition> = [
  { id: "light", name: "Light", mode: "light", bg: "#F8F5EF", panel: "#F1F0EA", accent: "#3A5C8C" },
];

export const DARK_THEMES: ReadonlyArray<ThemeDefinition> = [
  { id: "dark", name: "Dark", mode: "dark", bg: "#1A1C1E", panel: "#232526", accent: "#8EA8DA" },
];

export const ALL_THEMES: ReadonlyArray<ThemeDefinition> = [...LIGHT_THEMES, ...DARK_THEMES];

export function isDarkTheme(theme: Theme): boolean {
  return theme === "dark";
}

/** Themes tau no longer ships keep their light or dark side: an earlier light theme reads as Light, any other as Dark. */
const RETIRED_LIGHT_THEMES = new Set(["one-light", "catppuccin-latte", "rose-pine-dawn"]);
const RETIRED_DARK_THEMES = new Set(["midnight", "dracula", "harbor", "one-dark-pro", "rose-pine", "catppuccin-mocha", "gruvbox-dark", "nord", "tokyo-night"]);

const STORAGE_KEY = "tau-theme";
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** No stored choice follows the system's light or dark setting (the neutral palettes). */
function storedPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
    if (value && RETIRED_LIGHT_THEMES.has(value)) return "light";
    if (value && RETIRED_DARK_THEMES.has(value)) return "dark";
    return "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark = false): Theme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === "light") return "dark";
  if (preference === "dark") return "system";
  return "light";
}

export function applyDomTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const dark = isDarkTheme(theme);
  const cl = document.documentElement.classList;
  const toRemove: string[] = [];
  cl.forEach((cls) => {
    if (cls.startsWith("theme-")) toRemove.push(cls);
  });
  toRemove.forEach((cls) => cl.remove(cls));

  cl.toggle("dark", dark);
  cl.add(`theme-${theme}`);
  document.documentElement.setAttribute("data-theme", theme);
  const color = ALL_THEMES.find((definition) => definition.id === theme)?.panel;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && color) meta.setAttribute("content", color);
  if (!color) return;
  // The installed app's system bars use the manifest's color (lib/manifest-theme.ts):
  // the cookie lets the server render it into the link on the next load, and a
  // new href makes Chrome drop the manifest it cached for this page.
  document.cookie = `${THEME_COLOR_COOKIE}=${color.slice(1)}; path=/; max-age=31536000; SameSite=Lax`;
  const manifest = document.querySelector('link[rel="manifest"]');
  const href = manifestHref(color.slice(1));
  if (manifest && manifest.getAttribute("href") !== href) manifest.setAttribute("href", href);
}

function applyTheme(preference: ThemePreference): void {
  const theme = resolveTheme(preference, window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  applyDomTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Theme selection remains usable when storage is unavailable.
  }
  listeners.forEach((cb) => cb());
}

function getServerSnapshot(): ThemePreference {
  return "system";
}

type ToggleOrigin = { x: number; y: number };
function motionDurationMs(variable: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (raw.endsWith("ms")) {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  }
  if (raw.endsWith("s")) {
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value * 1000 : fallback;
  }
  return fallback;
}


export function useTheme() {
  const preference = useSyncExternalStore(subscribe, storedPreference, getServerSnapshot);
  // Read the OS preference in the first render: the client renders with createRoot (no hydration to match), and a
  // dark-OS user on the System default must not get a light first frame in every isDark consumer.
  const [osDark, setOsDark] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  // Track the OS color scheme in state so an OS light/dark flip changes the
  // snapshot and re-renders isDark consumers, even when the stored preference
  // itself ("system") is unchanged. Registered unconditionally at subscription
  // time: consumers on an explicit light/dark preference still keep osDark
  // fresh for when they switch back to system.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setOsDark(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  const theme = resolveTheme(preference, osDark);
  // Heal the DOM class on mount: stored preferences can predate the current
  // default, and pre-paint only runs on full page loads —
  // without this, hot-reloaded windows keep stale classes until restarted.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = resolveTheme(preference, window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    applyDomTheme(current);
  }, [preference]);

  useEffect(() => {
    if (preference !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current = resolveTheme("system", media.matches);
      applyDomTheme(current);
    };
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const setTheme = useCallback((next: ThemePreference, origin?: ToggleOrigin) => {
    const apply = () => applyTheme(next);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";
    if (!supportsVT || reduceMotion) {
      apply();
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(apply);
    transition.ready.then(() => {
      const styles = getComputedStyle(document.documentElement);
      document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] }, {
        duration: motionDurationMs("--dur-theme", 450),
        easing: styles.getPropertyValue("--ease-out-warm").trim() || "ease-out",
        pseudoElement: "::view-transition-new(root)",
      });
    }).catch(() => {});
    transition.finished?.catch(() => {});
  }, []);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => setTheme(nextThemePreference(preference), origin), [preference, setTheme]);

  return { theme, preference, isDark: isDarkTheme(theme), setTheme, toggleTheme };
}
