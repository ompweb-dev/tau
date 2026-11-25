import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

const { resolveTheme, isDarkTheme, THEME_PANEL, RETIRED_LIGHT_THEMES, RETIRED_DARK_THEMES, useTheme } = await import("./useTheme.ts");
const vm = await import("node:vm");

afterEach(cleanup);

test("resolves system theme from the operating system preference", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("ships one light and one dark theme", () => {
  assert.deepEqual(Object.keys(THEME_PANEL), ["light", "dark"]);
  assert.equal(isDarkTheme("light"), false);
  assert.equal(isDarkTheme("dark"), true);
});

test("each theme's browser chrome color is its CSS --bg-panel, the top bar's color", async () => {
  // The pre-paint script reads the CSS and the hook reads the table: a mismatch
  // flickers the status bar after hydration and sends a stale manifest color.
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const [id, panel] of Object.entries(THEME_PANEL)) {
    const selector = id === "light" ? ":root" : `html.theme-${id}`;
    // The first `:root` block holds the self-hosted font variables; take the one that sets --bg-panel.
    const match = css.match(new RegExp(`(^|, )${selector.replace(".", "\\.")} \\{[^}]*--bg-panel:\\s*(#[0-9A-Fa-f]{6})`, "m"));
    assert.equal(match?.[2].toUpperCase(), panel, id);
  }
});

test("browser chrome follows the selected theme and only follows OS changes in system mode", async (t) => {
  const root = document.documentElement;
  const originalClass = root.getAttribute("class");
  const originalTheme = root.getAttribute("data-theme");
  const originalPreference = localStorage.getItem("tau-theme");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#000000";
  document.head.append(meta);
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/api/manifest";
  document.head.append(manifest);
  root.className = "keep-layout dark theme-nord";
  localStorage.setItem("tau-theme", "dracula");

  const media = Object.assign(new window.EventTarget(), { matches: false });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query) => query === "(prefers-color-scheme: dark)" ? media : { matches: false },
  });
  t.after(() => {
    cleanup();
    meta.remove();
    manifest.remove();
    for (const [attribute, value] of [["class", originalClass], ["data-theme", originalTheme]]) {
      if (value === null) root.removeAttribute(attribute);
      else root.setAttribute(attribute, value);
    }
    if (originalPreference === null) localStorage.removeItem("tau-theme");
    else localStorage.setItem("tau-theme", originalPreference);
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else delete window.matchMedia;
  });

  let hook = renderHook(() => useTheme());
  const assertTheme = (theme, color, dark, classes, preference = theme, stored = preference) => {
    assert.equal(hook.result.current.theme, theme);
    assert.equal(hook.result.current.preference, preference);
    assert.equal(hook.result.current.isDark, dark);
    assert.equal(root.getAttribute("data-theme"), theme);
    assert.deepEqual([...root.classList].sort(), ["keep-layout", ...classes].sort());
    assert.equal(meta.getAttribute("content"), color);
    assert.match(document.cookie, new RegExp(`(^|; )tau-theme-color=${color.slice(1)}(;|$)`));
    // A new href makes Chrome drop its cached manifest and refetch the new color.
    assert.equal(manifest.getAttribute("href"), `/api/manifest?theme=${color.slice(1)}`);
    assert.equal(localStorage.getItem("tau-theme"), stored);
  };
  const changeOS = async (dark) => {
    await act(() => {
      media.matches = dark;
      media.dispatchEvent(new window.Event("change"));
    });
  };

  // A retired dark theme reads as Dark; the stored value stays until the user picks again.
  assertTheme("dark", "#232526", true, ["dark", "theme-dark"], "dark", "dracula");
  await changeOS(false);
  assertTheme("dark", "#232526", true, ["dark", "theme-dark"], "dark", "dracula");
  await act(() => hook.result.current.setTheme("light"));
  await changeOS(true);
  assertTheme("light", "#F1F0EA", false, ["theme-light"]);
  await act(() => hook.result.current.setTheme("system"));
  assertTheme("dark", "#232526", true, ["dark", "theme-dark"], "system");
  await changeOS(false);
  assertTheme("light", "#F1F0EA", false, ["theme-light"], "system");
  await changeOS(true);
  assertTheme("dark", "#232526", true, ["dark", "theme-dark"], "system");
  hook.unmount();
  await changeOS(false);
  assert.equal(root.getAttribute("data-theme"), "dark", "unmounted consumers no longer update browser chrome");
  assert.equal(meta.getAttribute("content"), "#232526");
  hook = renderHook(() => useTheme());
  assertTheme("light", "#F1F0EA", false, ["theme-light"], "system");
});

test("with no stored choice the theme follows the OS from the first render", (t) => {
  const originalPreference = localStorage.getItem("tau-theme");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  localStorage.removeItem("tau-theme");
  const media = Object.assign(new window.EventTarget(), { matches: true });
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => media });
  t.after(() => {
    cleanup();
    if (originalPreference !== null) localStorage.setItem("tau-theme", originalPreference);
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else delete window.matchMedia;
  });
  const seen = [];
  renderHook(() => { const value = useTheme(); seen.push([value.preference, value.theme, value.isDark]); return value; });
  assert.deepEqual(seen[0], ["system", "dark", true], "a dark OS gets dark on the very first render, not a light frame");
});

test("a retired light theme reads as Light", (t) => {
  const originalPreference = localStorage.getItem("tau-theme");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  localStorage.setItem("tau-theme", "catppuccin-latte");
  const media = Object.assign(new window.EventTarget(), { matches: true });
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => media });
  t.after(() => {
    cleanup();
    if (originalPreference === null) localStorage.removeItem("tau-theme");
    else localStorage.setItem("tau-theme", originalPreference);
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else delete window.matchMedia;
  });
  const { result } = renderHook(() => useTheme());
  assert.equal(result.current.preference, "light");
  assert.equal(result.current.theme, "light");
});

test("the pre-paint script picks the theme the hook will", async (t) => {
  // The script runs before the bundle, so it keeps its own copy of the retired-theme lists.
  const html = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>(\(function\(\)\{try\{var t;[\s\S]*?)<\/script>/)[1];
  const originalPreference = localStorage.getItem("tau-theme");
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  t.after(() => {
    cleanup();
    if (originalPreference === null) localStorage.removeItem("tau-theme");
    else localStorage.setItem("tau-theme", originalPreference);
    if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
    else delete window.matchMedia;
  });
  const stored = [null, "", "system", "light", "dark", "bogus", "constructor", "__proto__", "toString",
    ...RETIRED_LIGHT_THEMES, ...RETIRED_DARK_THEMES];
  for (const value of stored) {
    for (const osDark of [false, true]) {
      if (value === null) localStorage.removeItem("tau-theme");
      else localStorage.setItem("tau-theme", value);
      const media = Object.assign(new window.EventTarget(), { matches: osDark });
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: () => media });
      const classes = new Set();
      const attributes = {};
      const documentElement = { classList: { add: (name) => classes.add(name) }, setAttribute: (name, v) => { attributes[name] = v; } };
      vm.runInNewContext(script, {
        localStorage: { getItem: (key) => localStorage.getItem(key) },
        matchMedia: () => ({ matches: osDark }),
        document: { documentElement, querySelector: () => null },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
      });
      const { result, unmount } = renderHook(() => useTheme());
      const label = `${value} on a ${osDark ? "dark" : "light"} OS`;
      assert.equal(attributes["data-theme"], result.current.theme, label);
      assert.equal(classes.has("dark"), result.current.isDark, label);
      unmount();
    }
  }
});
