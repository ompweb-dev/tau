// Flat file & folder icons in var(--text-dim); a typed file's badge outline carries its language's hue (--file-*).

interface IconProps {
  size?: number;
}

const DIM = "var(--text-dim)";

// ── Folder ────────────────────────────────────────────────────────────────

export function FolderIcon({ size = 14, open = false }: IconProps & { open?: boolean }) {
  if (open) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <path d="M1 4.5A1 1 0 0 1 2 3.5H5.5L7 5h7.5v1H1V4.5Z" fill={DIM} />
        <path d="M1 6h14.5L14 13H2L1 6Z" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.12" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M1 4.5A1 1 0 0 1 2 3.5H5.5L7 5H14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4.5Z"
        stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.1" />
    </svg>
  );
}

// ── Generic file (fallback) ────────────────────────────────────────────────

export function GenericFileIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M3 2h7l3 3v9H3V2Z" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.08" />
      <path d="M10 2v3h3" stroke={DIM} strokeWidth="1" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

// ── File with label text (used for most types) ────────────────────────────
// Renders the file outline + a short text badge

/** A language's hue (app/globals.css `--file-*`, per theme); files without one stay dim. */
type Tone = "blue" | "yellow" | "green" | "teal" | "purple" | "pink" | "orange" | "red";

function LabelFileIcon({ label, size = 14, tone }: { label: string; size?: number; tone?: Tone }) {
  const s = size / 14; // scale factor
  const color = tone ? `var(--file-${tone})` : DIM;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      {/* No fill: a tint behind the label takes its contrast below 4.5:1 on a selected row. */}
      <path d="M2.5 1h6l3 3v9h-9V1Z" stroke={color} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      <path d="M8.5 1v3h3" stroke={color} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      <text
        x="7" y="9.5"
        textAnchor="middle"
        fontSize={3.4 * s}
        fontFamily="var(--font-mono), monospace"
        fontWeight="600"
        // The label stays --text-dim (4.6:1 or more on a selected row); the hue is the badge's outline.
        fill={DIM}
        letterSpacing="0"
      >{label}</text>
    </svg>
  );
}

// ── Specific icons ────────────────────────────────────────────────────────

export function MarkdownIcon({ size = 14 }: IconProps) {
  // file outline + M↓ symbol
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M2.5 1h6l3 3v9h-9V1Z" stroke={DIM} strokeWidth="0.9" fill={DIM} fillOpacity="0.07" strokeLinejoin="round" />
      <path d="M8.5 1v3h3" stroke={DIM} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      {/* M */}
      <path d="M3.5 9.5V7l1.5 1.5L6.5 7v2.5" stroke={DIM} strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* down arrow */}
      <path d="M8 7v2.5M7 9l1 1.5 1-1.5" stroke={DIM} strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
export function ShellIcon({ size = 14 }: IconProps) {
  // file outline + > prompt
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M2.5 1h6l3 3v9h-9V1Z" stroke={DIM} strokeWidth="0.9" fill={DIM} fillOpacity="0.07" strokeLinejoin="round" />
      <path d="M8.5 1v3h3" stroke={DIM} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      <path d="M4 7.5l2 1.5-2 1.5" stroke={DIM} strokeWidth="0.95" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M7.5 10.5h2.5" stroke={DIM} strokeWidth="0.95" strokeLinecap="round" />
    </svg>
  );
}
export function DockerfileIcon({ size = 14 }: IconProps) {
  // file outline + container stack
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M2.5 1h6l3 3v9h-9V1Z" stroke={DIM} strokeWidth="0.9" fill={DIM} fillOpacity="0.07" strokeLinejoin="round" />
      <path d="M8.5 1v3h3" stroke={DIM} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      <rect x="3.5" y="6.5" width="2" height="1.5" rx="0.3" stroke={DIM} strokeWidth="0.8" />
      <rect x="6" y="6.5" width="2" height="1.5" rx="0.3" stroke={DIM} strokeWidth="0.8" />
      <rect x="3.5" y="8.5" width="2" height="1.5" rx="0.3" stroke={DIM} strokeWidth="0.8" />
    </svg>
  );
}
export function EnvIcon({ size = 14 }: IconProps) {
  // file outline + key symbol
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M2.5 1h6l3 3v9h-9V1Z" stroke={DIM} strokeWidth="0.9" fill={DIM} fillOpacity="0.07" strokeLinejoin="round" />
      <path d="M8.5 1v3h3" stroke={DIM} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      <circle cx="5.5" cy="8.5" r="1.5" stroke={DIM} strokeWidth="0.9" />
      <path d="M7 8.5h2.5M8.5 8.5v1.5" stroke={DIM} strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}
export function GitIcon({ size = 14 }: IconProps) {
  // file outline + git branch lines
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M2.5 1h6l3 3v9h-9V1Z" stroke={DIM} strokeWidth="0.9" fill={DIM} fillOpacity="0.07" strokeLinejoin="round" />
      <path d="M8.5 1v3h3" stroke={DIM} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      <circle cx="5" cy="6.5" r="1" stroke={DIM} strokeWidth="0.85" />
      <circle cx="9" cy="6.5" r="1" stroke={DIM} strokeWidth="0.85" />
      <circle cx="5" cy="10" r="1" stroke={DIM} strokeWidth="0.85" />
      <path d="M5 7.5V9" stroke={DIM} strokeWidth="0.85" strokeLinecap="round" />
      <path d="M9 7.5v.5a2 2 0 0 1-2 2H6" stroke={DIM} strokeWidth="0.85" strokeLinecap="round" fill="none" />
    </svg>
  );
}
export function LockFileIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M2.5 1h6l3 3v9h-9V1Z" stroke={DIM} strokeWidth="0.9" fill={DIM} fillOpacity="0.07" strokeLinejoin="round" />
      <path d="M8.5 1v3h3" stroke={DIM} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      <rect x="4.5" y="8.5" width="5" height="3" rx="0.6" stroke={DIM} strokeWidth="0.9" />
      <path d="M5.5 8.5V7.5a1.5 1.5 0 0 1 3 0v1" stroke={DIM} strokeWidth="0.9" strokeLinecap="round" fill="none" />
    </svg>
  );
}
export function ConfigIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M2.5 1h6l3 3v9h-9V1Z" stroke={DIM} strokeWidth="0.9" fill={DIM} fillOpacity="0.07" strokeLinejoin="round" />
      <path d="M8.5 1v3h3" stroke={DIM} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      <circle cx="7" cy="8.5" r="1.3" stroke={DIM} strokeWidth="0.9" />
      <path d="M7 6.5v.7M7 10.3v.7M5 8.5h.7M8.3 8.5H9M5.5 6.9l.5.5M8.5 9.6l-.5-.5M5.5 10.1l.5-.5M8.5 7.4l-.5.5"
        stroke={DIM} strokeWidth="0.8" strokeLinecap="round" />
    </svg>
  );
}

// ── Main resolver ─────────────────────────────────────────────────────────

type Label = { label: string; tone?: Tone };
const label = (text: string, tone?: Tone): Label => ({ label: text, tone });
// Every type drawn as a labelled badge, by extension (a Map, so `constructor` or `__proto__` find nothing).
const LABELS = new Map<string, Label>([
  ...["ts", "mts", "cts"].map((ext) => [ext, label("TS", "blue")] as const),
  ["tsx", label("TSX", "blue")],
  ...["js", "mjs", "cjs"].map((ext) => [ext, label("JS", "yellow")] as const),
  ["jsx", label("JSX", "yellow")],
  ["py", label("PY", "teal")],
  ...["json", "jsonl"].map((ext) => [ext, label("{}", "yellow")] as const),
  ...["css", "less"].map((ext) => [ext, label("CSS", "purple")] as const),
  ["scss", label("SC", "pink")],
  ...["html", "htm"].map((ext) => [ext, label("HTM", "orange")] as const),
  ...["yaml", "yml"].map((ext) => [ext, label("YML", "red")] as const),
  ["toml", label("TOM")],
  ["rs", label("RS", "orange")],
  ["go", label("GO", "teal")],
  ["sql", label("SQL", "yellow")],
  ...["graphql", "gql"].map((ext) => [ext, label("GQL", "pink")] as const),
  ...["tf", "hcl"].map((ext) => [ext, label("TF", "purple")] as const),
  ["docx", label("DOC", "blue")],
  ["pdf", label("PDF", "red")],
  ["c", label("C", "blue")],
  ["h", label("H", "purple")],
  ...["cc", "cpp", "cxx"].map((ext) => [ext, label("C++", "blue")] as const),
  ...["hh", "hpp", "hxx"].map((ext) => [ext, label("H++", "purple")] as const),
  ["cs", label("C#", "purple")],
  ["java", label("JV", "orange")],
  ["kt", label("KT", "purple")],
  ["swift", label("SW", "orange")],
  ["rb", label("RB", "red")],
  ["php", label("PHP", "purple")],
  ["lua", label("LUA", "blue")],
  ["zig", label("ZIG", "orange")],
  ["cmake", label("CM", "green")],
  // Not .obj: in C and C++ trees that is usually a compiled object file.
  ...["glb", "gltf", "stl"].map((ext) => [ext, label("3D", "teal")] as const),
]);

export function getFileIcon(name: string, size = 14): React.ReactNode {
  const lower = name.toLowerCase();
  // A name without a dot (a file called `h`) has no extension.
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";

  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return <DockerfileIcon size={size} />;
  if (lower === ".env" || lower.startsWith(".env.")) return <EnvIcon size={size} />;
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") return <GitIcon size={size} />;
  if (lower === "package-lock.json" || lower === "yarn.lock" || lower === "bun.lock" || lower === "pnpm-lock.yaml" || lower === "cargo.lock") return <LockFileIcon size={size} />;
  if (lower.endsWith(".config.ts") || lower.endsWith(".config.js") || lower.endsWith(".config.mjs") || lower.endsWith(".config.cjs")) return <ConfigIcon size={size} />;
  if ([".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", "eslint.config.mjs", "eslint.config.js"].includes(lower)) return <ConfigIcon size={size} />;

  switch (ext) {
    case "md":
    case "mdx":     return <MarkdownIcon size={size} />;
    case "sh":
    case "bash":
    case "zsh":
    case "fish":    return <ShellIcon size={size} />;
    case "lock":    return <LockFileIcon size={size} />;
  }
  const badge = lower === "cmakelists.txt" ? LABELS.get("cmake") : LABELS.get(ext);
  return badge ? <LabelFileIcon label={badge.label} size={size} tone={badge.tone} /> : <GenericFileIcon size={size} />;
}
