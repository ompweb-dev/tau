import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "@/components/ui/toast";
import { sendAgentCommand } from "@/lib/agent-client";
import { translate } from "@/lib/i18n";
import { applyBtwEvent, isBtwRecord, latestBtwTurn, mergeBtwHistory, upsertBtwRecord, type BtwRecord } from "@/lib/btw";
import { scheduleAtDisplayRate } from "@/lib/message-update-coalescer";

export function toastBtwError(error: unknown): void {
  toast.error(translate("btw.failed"), error instanceof Error ? error.message : String(error));
}

type BtwFrame = { type: string; [key: string]: unknown };

/** Side questions (`/btw`, answered by tau's pi extension) for one chat: the session's BTW history fed by
 * `btw_record`/`btw_delta` frames, the record shown in the composer panel, and
 * the history dialog. Never touches the main transcript. */
/** `hostOf` names the shown session's host ("local" = this machine): its commands go to that copy. */
export function useBtw(sessionIdRef: RefObject<string | null>, hostOf: () => string) {
  const [records, setRecords] = useState<BtwRecord[]>([]);
  // Synchronous mirror of `records`: what this tab already knows decides
  // auto-opening and which running records a history snapshot may interrupt.
  const recordsRef = useRef<BtwRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Deltas arrive at token rate; apply them at display rate (hidden-tab safe).
  const pendingFramesRef = useRef<BtwFrame[]>([]);
  const cancelFlushRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelFlushRef.current?.(), []);

  const commit = useCallback((update: (prev: BtwRecord[]) => BtwRecord[]) => {
    const next = update(recordsRef.current);
    if (next === recordsRef.current) return;
    recordsRef.current = next;
    setRecords(next);
  }, []);

  const flushFrames = useCallback(() => {
    cancelFlushRef.current?.();
    cancelFlushRef.current = null;
    const frames = pendingFramesRef.current;
    if (frames.length === 0) return;
    pendingFramesRef.current = [];
    const known = new Set(recordsRef.current.map((record) => record.id));
    commit((prev) => frames.reduce(applyBtwEvent, prev));
    // A side question started elsewhere (another tab) opens the panel; a
    // topic this tab already knows never reopens a panel the user closed.
    const started = frames.map((frame) => frame.record)
      .findLast((record): record is BtwRecord => isBtwRecord(record) && latestBtwTurn(record).status === "running" && !known.has(record.id));
    if (started) setActiveId(started.id);
  }, [commit]);

  const applyEvent = useCallback((event: BtwFrame) => {
    pendingFramesRef.current.push(event);
    cancelFlushRef.current ??= scheduleAtDisplayRate(flushFrames);
  }, [flushFrames]);

  /** Merge the session's side-question history. Background refreshes (SSE open, reconcile, a no-op
   * cancel) stay silent: the route never starts pi for them. */
  const refreshHistory = useCallback(async (sid: string, explicit = false) => {
    const knownBefore = new Set(recordsRef.current.map((record) => record.id));
    try {
      const data = await sendAgentCommand<{ records?: unknown[] } | null>(sid, hostOf(), { type: "get_btw_history" });
      if (sessionIdRef.current !== sid) return;
      const snapshot = (data?.records ?? []).filter(isBtwRecord);
      // Frames already received go first: the staleness rules then keep
      // whichever of them and the snapshot is newer. Applied after it, deltas
      // the snapshot already holds would be appended twice.
      flushFrames();
      const known = new Set(recordsRef.current.map((record) => record.id));
      commit((prev) => mergeBtwHistory(prev, snapshot, knownBefore));
      const running = snapshot.find((record) => latestBtwTurn(record).status === "running" && !known.has(record.id));
      if (running) setActiveId((id) => id ?? running.id);
    } catch (error) {
      if (explicit) toastBtwError(error);
    }
  }, [commit, flushFrames, hostOf, sessionIdRef]);

  /** Half-open SSE recovery: re-read the history while an answer is still running. */
  const reconcile = useCallback((sid: string) => {
    if (recordsRef.current.some((record) => latestBtwTurn(record).status === "running")) void refreshHistory(sid);
  }, [refreshHistory]);

  /** `/btw` alone: the history dialog. Unlike background reads, this starts pi. */
  const openHistory = useCallback(async (sid: string) => {
    setHistoryOpen(true);
    try {
      await sendAgentCommand(sid, hostOf(), { type: "get_state" });
    } catch (error) {
      toastBtwError(error);
      return;
    }
    await refreshHistory(sid, true);
  }, [hostOf, refreshHistory]);

  /** Resolves once tau's extension accepted the question; the answer streams via frames. Throws on refusal. */
  const ask = useCallback(async (sid: string, question: string, recordId?: string): Promise<void> => {
    const data = await sendAgentCommand<{ record?: unknown } | null>(sid, hostOf(), { type: "btw", question, ...(recordId ? { recordId } : {}) });
    const record = data?.record;
    if (sessionIdRef.current !== sid || !isBtwRecord(record)) return;
    // The start state: never newer than frames, so upsert keeps streamed text.
    commit((prev) => upsertBtwRecord(prev, record));
    setActiveId(record.id);
  }, [commit, hostOf, sessionIdRef]);

  const cancel = useCallback(async (recordId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const data = await sendAgentCommand<{ cancelled?: boolean } | null>(sid, hostOf(), { type: "btw_cancel", recordId });
      // Nothing was running: the shown state is stale (missed frame, lost child).
      if (data?.cancelled === false) await refreshHistory(sid);
    } catch (error) {
      toastBtwError(error);
    }
  }, [hostOf, refreshHistory, sessionIdRef]);

  return { records, activeId, setActiveId, historyOpen, setHistoryOpen, applyEvent, reconcile, refreshHistory, openHistory, ask, cancel };
}
