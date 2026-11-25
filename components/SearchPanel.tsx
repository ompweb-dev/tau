"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronRight, Search } from "lucide-react";
import { getFileIcon } from "./FileIcons";
import { translate, useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { getFileDirectory, getFileName } from "@/lib/file-paths";
import type { WorkspaceTextMatch, WorkspaceTextSearch } from "@/lib/workspace-types";

interface Props {
  cwd: string;
  hostId: string;
  sourceSessionId?: string | null;
  /** Bumped by the panel's refresh: the shown search runs again. */
  refreshKey: number;
  /** `relativePath` is relative to `cwd`. */
  onOpenMatch: (relativePath: string, line: number) => void;
}

type State =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "done"; result: WorkspaceTextSearch }
  | { status: "failed"; error: string };

/** Literal text search across the workspace's files, grouped by file. */
export function SearchPanel({ cwd, hostId, sourceSessionId, refreshKey, onOpenMatch }: Props) {
  const { t, tn } = useI18n();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!query) { setState({ status: "idle" }); return; }
    const controller = new AbortController();
    setState({ status: "searching" });
    // Each run reads every text file: wait for a pause in typing.
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ cwd, hostId, q: query });
      if (caseSensitive) params.set("case", "1");
      if (sourceSessionId) params.set("sessionId", sourceSessionId);
      fetch(`/api/file-search?${params}`, { signal: controller.signal })
        .then(async (res) => {
          if (res.ok) return res.json() as Promise<WorkspaceTextSearch>;
          const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
          throw new Error(formatApiError({ ...body, error: body.error ?? translate("searchPanel.failed", { status: res.status }) }));
        })
        .then((result) => {
          if (controller.signal.aborted) return;
          setCollapsed(new Set());
          setState({ status: "done", result });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ status: "failed", error: error instanceof Error ? error.message : String(error) });
        });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, hostId, sourceSessionId, query, caseSensitive, refreshKey]);

  const files = useMemo(() => {
    const grouped = new Map<string, WorkspaceTextMatch[]>();
    if (state.status === "done") for (const match of state.result.matches) grouped.set(match.path, [...grouped.get(match.path) ?? [], match]);
    return [...grouped];
  }, [state]);

  const toggle = (file: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (!next.delete(file)) next.add(file);
    return next;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="search-panel-field">
        <Search size={13} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value.slice(0, 500))}
          placeholder={t("searchPanel.placeholder")}
          aria-label={t("searchPanel.placeholder")}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="search-panel-toggle ui-focus-ring"
          aria-pressed={caseSensitive}
          title={t("searchPanel.matchCase")}
          aria-label={t("searchPanel.matchCase")}
          onClick={() => { setCaseSensitive((on) => !on); inputRef.current?.focus(); }}
        >
          <CaseSensitive size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div role="status" className="search-panel-status">
        {state.status === "searching" ? t("searchPanel.searching")
          : state.status === "failed" ? state.error
            : state.status === "done" ? (
              state.result.matches.length === 0 ? t("searchPanel.noResults")
                : `${tn("searchPanel.results", state.result.matches.length)} · ${tn("searchPanel.files", files.length)}${state.result.truncated ? ` · ${t("searchPanel.truncated")}` : ""}`
            ) : null}
      </div>
      <div className="search-panel-results" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {files.map(([file, matches]) => {
          const open = !collapsed.has(file);
          const directory = getFileDirectory(file);
          return (
            <div key={file}>
              <button type="button" className="search-panel-file ui-focus-ring" aria-expanded={open} title={file} onClick={() => toggle(file)}>
                <ChevronRight size={12} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined }} />
                {getFileIcon(getFileName(file), 13)}
                <span className="search-panel-file-name">{getFileName(file)}</span>
                {directory && <span className="search-panel-file-dir">{directory}</span>}
                <span className="search-panel-count">{matches.length}</span>
              </button>
              {open && matches.map((match) => (
                <button
                  type="button"
                  key={match.line}
                  className="search-panel-match ui-focus-ring"
                  title={`${file}:${match.line}`}
                  onClick={() => onOpenMatch(file, match.line)}
                >
                  <span className="search-panel-line">{match.line}</span>
                  <span className="search-panel-text">
                    {match.text.slice(0, match.column).trimStart()}
                    <mark>{match.text.slice(match.column, match.column + match.length)}</mark>
                    {match.text.slice(match.column + match.length)}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
