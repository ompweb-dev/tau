import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/lib/i18n";

/** A line-range mention as `buildFileLineMentionText` writes it: `@path:12` or `@"a path":12-30`. */
const LINE_MENTION = /@(?:"[^"\n]+"|[^\s"]+):\d+(?:-\d+)?(?=\s|$)/g;

/** The composer text split into plain runs and line-range mentions. */
export function splitLineMentions(value: string): { text: string; mention: boolean }[] {
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const match of value.matchAll(LINE_MENTION)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: value.slice(last, index), mention: false });
    parts.push({ text: match[0], mention: true });
    last = index + match[0].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last), mention: false });
  return parts;
}

/**
 * Painted under the composer's textarea (which has no background): line-range mentions get a chip behind their
 * text, and an empty composer shows its hints. The text itself stays the textarea's, so typing, drafts and
 * sending are unchanged; this layer only mirrors its wrapping and scroll position.
 */
export function ComposerMirror({ value, textareaRef, fontFamily }: { value: string; textareaRef: RefObject<HTMLTextAreaElement | null>; fontFamily: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const sync = () => {
    if (ref.current && textareaRef.current) ref.current.scrollTop = textareaRef.current.scrollTop;
  };
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.addEventListener("scroll", sync);
    return () => textarea.removeEventListener("scroll", sync);
    // sync reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textareaRef]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(sync, [value]);

  let content: ReactNode;
  if (!value) {
    content = (
      <>
        <span className="composer-hint-lead">{t("chatInput.askAnything")}</span>
        <span className="composer-hint"><kbd>@</kbd> {t("chatInput.hintFiles")}</span>
        <span className="composer-hint"><kbd>/</kbd> {t("chatInput.hintCommands")}</span>
        <span className="composer-hint"><kbd>!</kbd> {t("chatInput.hintShell")}</span>
      </>
    );
  } else {
    const parts = splitLineMentions(value);
    // Nothing to paint: the textarea alone.
    if (!parts.some((part) => part.mention)) return null;
    // The trailing newline keeps the last (empty) line's height, as the textarea has it.
    content = <>{parts.map((part, index) => part.mention ? <mark key={index} className="composer-chip">{part.text}</mark> : part.text)}{"\n"}</>;
  }
  return <div ref={ref} aria-hidden="true" className="composer-mirror" style={{ fontFamily }}>{content}</div>;
}
