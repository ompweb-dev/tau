import { memo, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/lib/i18n";

/**
 * A line-range mention as `buildFileLineMentionText` writes it: `@path:12` or `@"a path":12-30`, at the start of the
 * text or after whitespace (as `extractAtQuery` takes an `@`), so `git@github.com:22` is not one.
 */
const LINE_MENTION = /(?<=^|\s)@(?:"[^"\n]+"|[^\s"]+):\d+(?:-\d+)?(?=\s|$)/g;

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

/** Follows the textarea's scroll position and leaves out its scrollbar (when it shows one), so both wrap alike. */
function syncMirror(textarea: HTMLTextAreaElement | null, mirror: HTMLDivElement | null) {
  if (!textarea || !mirror) return;
  mirror.style.right = `${textarea.offsetWidth - textarea.clientWidth}px`;
  mirror.scrollTop = textarea.scrollTop;
}

/**
 * Painted under the composer's textarea (which has no background): line-range mentions get a chip behind their
 * text, and an empty composer shows its hints. The text itself stays the textarea's, so typing, drafts and
 * sending are unchanged; this layer only mirrors its wrapping width and scroll position.
 */
export const ComposerMirror = memo(function ComposerMirror({ value, textareaRef, fontFamily }: { value: string; textareaRef: RefObject<HTMLTextAreaElement | null>; fontFamily: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const parts = useMemo(() => value ? splitLineMentions(value) : [], [value]);
  const painted = !value || parts.some((part) => part.mention);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !painted) return;
    const onChange = () => syncMirror(textarea, ref.current);
    textarea.addEventListener("scroll", onChange);
    // Where ResizeObserver is missing, the mirror still follows each change of the text.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onChange);
    observer?.observe(textarea);
    return () => {
      textarea.removeEventListener("scroll", onChange);
      observer?.disconnect();
    };
  }, [textareaRef, painted]);
  // After each change of the text or font, and again next frame: ChatInput resizes the textarea in its own layout
  // effect, which runs after this one.
  useLayoutEffect(() => {
    syncMirror(textareaRef.current, ref.current);
    const frame = requestAnimationFrame(() => syncMirror(textareaRef.current, ref.current));
    return () => cancelAnimationFrame(frame);
  }, [textareaRef, value, painted, fontFamily]);

  if (!painted) return null;
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
    // The trailing newline keeps the last (empty) line's height, as the textarea has it.
    content = <>{parts.map((part, index) => part.mention ? <mark key={index} className="composer-chip">{part.text}</mark> : part.text)}{"\n"}</>;
  }
  return <div ref={ref} aria-hidden="true" className={value ? "composer-mirror" : "composer-mirror composer-mirror-hints"} style={{ fontFamily }}>{content}</div>;
});
