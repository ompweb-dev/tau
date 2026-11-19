export const ANSI_RE = /\x1B\[[0-9;]*m/g;

/** Parse `--json` stdout, tolerating stray non-JSON lines before the payload. */
export function parseJsonLoose<T>(stdout: string): T | null {
  const cleaned = stdout.replace(ANSI_RE, "");
  const start = cleaned.search(/[{[]/);
  if (start < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start)) as T;
  } catch {
    return null;
  }
}

export interface PiPackageEntry {
  source: string;
  path: string;
  scope: "global" | "project";
}

/** Parse `pi list` stdout (`User packages:` / `Project packages:` sections). */
export function parsePiListOutput(stdout: string): PiPackageEntry[] {
  const cleaned = stdout.replace(ANSI_RE, "");
  const entries: PiPackageEntry[] = [];
  let scope: "global" | "project" | null = null;
  // pi prints a package's installed path on the next, deeper line only when it is installed.
  let last: PiPackageEntry | null = null;
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (trimmed === "User packages:") { scope = "global"; last = null; continue; }
    if (trimmed === "Project packages:") { scope = "project"; last = null; continue; }
    if (!scope) continue;
    if (/^\s{4}/.test(rawLine)) {
      if (last && !last.path) last.path = trimmed;
    } else if (/^\s{2}/.test(rawLine)) {
      last = { source: trimmed.replace(/ \(filtered\)$/, ""), path: "", scope };
      entries.push(last);
    }
  }
  return entries;
}
