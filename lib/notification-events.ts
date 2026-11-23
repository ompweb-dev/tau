import { isRecord } from "./type-guards";

/**
 * Notification events shared by the server (detection, routing, push) and the
 * browser (in-app toasts, in-page system notifications, settings).
 */

export const NOTIFICATION_TYPES = ["completed", "input", "error"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** One question of an `ask` dialog, reduced to what a notification can answer. */
export interface NotificationDialogQuestion {
  id: string;
  question: string;
  /** Option labels (the web dialog sends labels back as `selectedOptions`). */
  options?: string[];
  multi?: boolean;
  /** The web dialog always offers an "Other" free-text field unless pi forbids it. */
  allowCustom?: boolean;
}

/**
 * The blocking extension dialog behind an `input` notification. Carried in the
 * SSE frame, the history entry and the push body so the native app can render
 * Yes/No/option buttons or a reply field without an open chat tab.
 */
export interface NotificationDialog {
  requestId: string;
  method: "select" | "confirm" | "input" | "editor" | "ask";
  title?: string;
  message?: string;
  options?: string[];
  questions?: NotificationDialogQuestion[];
  placeholder?: string;
  /** Wall-clock expiry (ms), present when pi set a timeout. */
  expiresAt?: number;
}

export interface NotificationEvent {
  /** `test` is only sent by the settings "Send test notification" button. */
  type: NotificationType | "test";
  sessionId: string;
  sessionName: string | null;
  /** Question or error text. */
  detail?: string;
  /** `input` only: the id a retraction (`publishNotificationDismiss`) matches. */
  requestId?: string;
  /** `input` only: the dialog waiting for an answer, when it fits a push payload. */
  dialog?: NotificationDialog;
}

/** One entry of the persisted notification history; `id` is the replace-tag `<sessionId>:<type>`. */
export interface NotificationHistoryEntry {
  id: string;
  event: NotificationEvent;
  at: number;
  read: boolean;
}

export interface NotificationPrefs {
  enabled: boolean;
  types: Record<NotificationType, boolean>;
  /** While the user is active in another tau tab: in-app toast or system notification. */
  whenActive: "toast" | "system";
  /** UI locale, so pushes are written in the device's language. */
  locale: string;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: false,
  types: { completed: true, input: true, error: true },
  whenActive: "toast",
  locale: "en",
};

/** Validate untrusted prefs (request bodies, localStorage); unknown fields fall back to defaults. */
export function parseNotificationPrefs(value: unknown): NotificationPrefs {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawTypes = raw.types && typeof raw.types === "object" ? (raw.types as Record<string, unknown>) : {};
  const types = { ...DEFAULT_NOTIFICATION_PREFS.types };
  for (const type of NOTIFICATION_TYPES) {
    if (typeof rawTypes[type] === "boolean") types[type] = rawTypes[type] as boolean;
  }
  return {
    enabled: raw.enabled === true,
    types,
    whenActive: raw.whenActive === "system" ? "system" : "toast",
    locale: typeof raw.locale === "string" && /^[A-Za-z-]{2,10}$/.test(raw.locale) ? raw.locale : "en",
  };
}

export interface RenderedNotification {
  title: string;
  body: string;
  url: string;
  tag: string;
  sessionId: string;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const MAX_DETAIL = 180;
/** Session names can be pasted at any length; push payloads are capped near 4 KB. */
const MAX_TITLE = 100;

function clip(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The decision text a dialog carries, verbatim: a confirm's title and message,
 * an ask's questions, or the title of a select/input/editor. The body of an
 * `input` event uses this instead of the clipped `detail`, so a push can never
 * show only the harmless prefix of an approval whose buttons are live.
 */
function dialogBody(dialog: NotificationDialog | undefined): string | undefined {
  if (!dialog) return undefined;
  if (dialog.method === "confirm") {
    const parts = [dialog.title, dialog.message].filter((text): text is string => Boolean(text));
    return parts.length > 0 ? parts.join(" — ") : undefined;
  }
  if (dialog.method === "ask") {
    const questions = (dialog.questions ?? []).map((question) => question.question);
    return questions.length > 0 ? questions.join("\n") : dialog.title;
  }
  return dialog.title;
}

/** Title, body, click target, and replace-tag for one event in the caller's language. */
export function renderNotification(event: NotificationEvent, t: Translate): RenderedNotification {
  const dialogDetail = event.type === "input" ? dialogBody(event.dialog) : undefined;
  const detail = dialogDetail || (event.detail ? clip(event.detail) : "");
  let body: string;
  switch (event.type) {
    case "completed":
      body = t("notifications.completedBody");
      break;
    case "input":
      body = detail ? t("notifications.inputBody", { detail }) : t("notifications.inputBodyNoDetail");
      break;
    case "error":
      body = detail ? t("notifications.errorBody", { detail }) : t("notifications.errorBodyNoDetail");
      break;
    case "test":
      body = t("notifications.testBody");
      break;
  }
  return {
    title: (event.sessionName && clip(event.sessionName, MAX_TITLE)) || t("notifications.untitledSession"),
    body,
    url: event.sessionId ? `/?session=${encodeURIComponent(event.sessionId)}` : "/",
    tag: `${event.sessionId}:${event.type}`,
    sessionId: event.sessionId,
  };
}

/**
 * Extension UI dialogs a notification can answer. Only these five arm an answer.
 */
export const DIALOG_UI_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor", "askDialog"]);

const NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Client and device ids: generated by the browser, checked by the server. */
export function isValidNotificationId(value: unknown): value is string {
  return typeof value === "string" && NOTIFICATION_ID_PATTERN.test(value);
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** True when a field carries text (or a non-text value) a notification cannot render. */
function carriesVisibleText(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim() !== "";
}

// Push payloads must stay well under the 4 KB Web Push limit. A dialog that
// cannot be represented within these caps is omitted entirely so the app falls
// back to "Open" instead of showing a partial question.
const DIALOG_TEXT = { title: 160, message: 480, placeholder: 80, option: 160, question: 240, questionOption: 120 };
const DIALOG_COUNTS = { options: 12, questions: 5, questionOptions: 9 };
const DIALOG_ID_CHARS = 128;
const MAX_DIALOG_BYTES = 1800;
const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };
const encoder = new TextEncoder();

/**
 * One line of dialog text, or `null` when the whole text does not fit the
 * notification's budget. Truncating is never an option: a `confirm` that showed
 * only the harmless prefix of an approval would stay answerable. Absent or
 * empty text is `undefined` (the dialog's other fields still identify it).
 */
function exactDialogText(value: unknown, max: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? null : flat;
}

/**
 * Option labels travel back to pi as the answer and are compared verbatim
 * (`extension_ui_response.selectedOptions`), so they are never trimmed,
 * flattened or clipped. A set that has to be altered to fit the notification
 * makes the whole dialog unrepresentable: the notification then only opens
 * the session instead of sending an answer pi would not match.
 */
function exactDialogOptions(value: unknown, maxCount: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxCount) return undefined;
  const labels: string[] = [];
  for (const entry of value) {
    const label = typeof entry === "string" ? entry : isRecord(entry) ? entry.label : undefined;
    if (typeof label !== "string" || label.length === 0 || label.length > maxChars) return undefined;
    // The web renders an option's description and preview as decision text; the
    // notification has no field for them, so such a dialog must not be offered.
    if (isRecord(entry) && (carriesVisibleText(entry.description) || carriesVisibleText(entry.preview))) return undefined;
    labels.push(label);
  }
  return labels.length > 0 ? labels : undefined;
}

/** `ask` questions: ids must be unique and complete, or the whole dialog is unusable. */
function dialogQuestions(value: unknown): NotificationDialogQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > DIALOG_COUNTS.questions) return undefined;
  const questions: NotificationDialogQuestion[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    // The id is the key pi matches the answer against; trimming it could
    // answer a different question, so a padded id makes the dialog unusable.
    const id = typeof raw.id === "string" ? raw.id : "";
    // A question header is rendered by the web as decision context.
    if (carriesVisibleText(raw.header)) return undefined;
    const question = exactDialogText(raw.question, DIALOG_TEXT.question);
    if (!id || id.trim() !== id || id.length > DIALOG_ID_CHARS || ids.has(id) || !question) return undefined;
    ids.add(id);
    const entry: NotificationDialogQuestion = { id, question };
    // A non-empty list must survive exactly or the question would lose
    // choices; an empty list is just a free-text question.
    if (raw.options !== undefined && raw.options !== null) {
      if (!Array.isArray(raw.options)) return undefined;
      if (raw.options.length > 0) {
        const options = exactDialogOptions(raw.options, DIALOG_COUNTS.questionOptions, DIALOG_TEXT.questionOption);
        if (!options) return undefined;
        entry.options = options;
      }
    }
    if (raw.multi === true) entry.multi = true;
    // Same rule as ExtensionDialog: every question may be answered with "Other".
    if (raw.allowCustom !== false) entry.allowCustom = true;
    questions.push(entry);
  }
  return questions;
}

/**
 * Reduce a blocking `extension_ui_request` frame to the answerable dialog a
 * notification carries. Returns undefined for `open_url` (no answer) and for
 * any frame the push payload cannot represent *exactly*: a field that would
 * have to be truncated, an option set that would change, or a dialog over the
 * byte budget. The notification then only opens the session — it never offers
 * an answer based on a partial question.
 */
export function buildNotificationDialog(frame: Record<string, unknown>): NotificationDialog | undefined {
  const method = typeof frame.method === "string" ? frame.method : "";
  if (!DIALOG_METHODS[method]) return undefined;
  // The id is echoed in the answer; never trim it into a different request.
  const requestId = typeof frame.id === "string" ? frame.id : "";
  if (!requestId || requestId.trim() !== requestId || requestId.length > DIALOG_ID_CHARS) return undefined;

  const dialog: NotificationDialog = { requestId, method: method as NotificationDialog["method"] };
  const title = exactDialogText(frame.title, DIALOG_TEXT.title);
  if (title === null) return undefined;
  if (title) dialog.title = title;

  switch (dialog.method) {
    case "select": {
      const options = exactDialogOptions(frame.options, DIALOG_COUNTS.options, DIALOG_TEXT.option);
      if (!options) return undefined;
      dialog.options = options;
      break;
    }
    case "confirm": {
      const message = exactDialogText(frame.message, DIALOG_TEXT.message);
      if (message === null) return undefined;
      if (message) dialog.message = message;
      break;
    }
    case "input": {
      const placeholder = exactDialogText(frame.placeholder, DIALOG_TEXT.placeholder);
      if (placeholder === null) return undefined;
      if (placeholder) dialog.placeholder = placeholder;
      break;
    }
    case "editor":
      // The editor body (prefill) is not part of the notification contract: the
      // app opens the session to edit it. The title is enough to name it.
      break;
    case "ask": {
      const questions = dialogQuestions(frame.questions);
      if (!questions) return undefined;
      dialog.questions = questions;
      break;
    }
  }

  // Nothing user-visible to show: the notification body already carries detail.
  if (!dialog.title && !dialog.message && !dialog.placeholder && !dialog.questions && !dialog.options) return undefined;
  if (typeof frame.expiresAt === "number" && Number.isFinite(frame.expiresAt) && frame.expiresAt > 0) dialog.expiresAt = frame.expiresAt;
  if (encoder.encode(JSON.stringify(dialog)).byteLength > MAX_DIALOG_BYTES) return undefined;
  return dialog;
}

/**
 * tau's `ui_request` carries the dialog's fields positionally in `args`;
 * the notification contract names them. Methods that cannot be answered from a
 * notification (a whole-form ask, an approval) map to undefined.
 */
function notificationDialogFrame(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  const method = typeof frame.method === "string" ? frame.method : "";
  const args = Array.isArray(frame.args) ? frame.args : [];
  // A server-owned confirm renders from/to/delivery/host/cwd in `serverPayload`
  // (ExtensionDialog's ServerConfirmBody). The notification contract has no
  // field for them, so carrying only the message would still approve a decision
  // the user cannot see in full: omit the dialog and open the session.
  if (frame.serverPayload !== undefined && frame.serverPayload !== null) return undefined;
  // Never turn a missing id into the request id "undefined".
  const rawId = frame.id;
  if (typeof rawId !== "string" && typeof rawId !== "number") return undefined;
  if (typeof rawId === "number" && !Number.isSafeInteger(rawId)) return undefined;
  const base: Record<string, unknown> = { id: String(rawId), expiresAt: frame.expiresAt };
  switch (method) {
    case "select":
      return { ...base, method, title: args[0], options: args[1] };
    case "confirm":
      return { ...base, method, title: args[0], message: args[1] };
    case "input": {
      const options = isRecord(args[2]) ? args[2] : undefined;
      // The web masks a secret input; a notification answer would type it into
      // plain sight, so such a dialog is not answerable from a notification.
      if (options && Boolean(options.secret)) return undefined;
      return { ...base, method, title: args[0], placeholder: args[1] };
    }
    case "editor":
      return { ...base, method, title: args[0], prefill: args[1] };
    case "askDialog":
      return { ...base, method: "ask", questions: args[0] };
    default:
      return undefined;
  }
}

/**
 * Whether a pending wire dialog is one the notification could actually carry.
 * The answer route refuses anything else, so a request the notification had to
 * omit (unrepresentable text, an oversized payload, a whole-form dialog, an
 * approval or `open_url`) is not answerable from a notification either.
 */
export function isNotificationAnswerable(frame: Record<string, unknown>): boolean {
  const mapped = notificationDialogFrame(frame);
  return mapped !== undefined && buildNotificationDialog(mapped) !== undefined;
}

type Detect = (frame: Record<string, unknown>, session: { sessionId: string; sessionName: string | null }) => NotificationEvent[];

/**
 * Per-session detector: feed it every top-level RPC frame in order. Subagent
 * activity arrives wrapped in `subagent_*` frames and is never inspected.
 *
 * "completed" fires on `session_settled` (the run and any background work it
 * started are done), unless the last prompt in that stretch failed or was
 * aborted. Errors fire on the failing `prompt_result` itself.
 */
export function createNotificationDetector(): Detect {
  let lastOutcome: string | null = null;
  /** tau already reported this run's failure (from a failed `response`); its `prompt_result` must not repeat it. */
  let failureReported = false;

  return (frame, { sessionId, sessionName }) => {
    const base = { sessionId, sessionName };
    switch (frame.type) {
      case "agent_start":
        failureReported = false;
        return [];
      // tau's own frames: an async prompt failure (`response` with
      // success: false) and the pi child exiting mid-run.
      case "prompt_error":
      case "process_exit": {
        lastOutcome = "error";
        if (failureReported) return [];
        failureReported = true;
        return [{ ...base, type: "error", detail: str(frame.errorMessage) ?? str(frame.detail) }];
      }
      case "prompt_result": {
        if (frame.agentInvoked !== true) return [];
        lastOutcome = str(frame.status) ?? null;
        if (lastOutcome !== "error" || failureReported) return [];
        failureReported = true;
        return [{ ...base, type: "error", detail: isRecord(frame.error) ? str(frame.error.message) : undefined }];
      }
      case "session_settled": {
        const outcome = lastOutcome;
        lastOutcome = null;
        failureReported = false;
        if (outcome === "error" || outcome === "aborted") return [];
        return [{ ...base, type: "completed" }];
      }
      case "ui_request": {
        // Only reached for dialogs that wait on the user (tau answers
        // auto-approved ones before they are emitted). args[0] is the title
        // or an ask's questions.
        const args = Array.isArray(frame.args) ? frame.args : [];
        const first: unknown = args[0];
        const detail = str(first)
          ?? (Array.isArray(first) && isRecord(first[0]) ? str(first[0].question) : undefined)
          ?? str(args[1]);
        const event: NotificationEvent = { ...base, type: "input", detail };
        // Carried even without a dialog (form/approve/oversized payload) so the
        // matching retraction can still close this notification.
        if (frame.id !== undefined) event.requestId = String(frame.id);
        const mapped = notificationDialogFrame(frame);
        const dialog = mapped ? buildNotificationDialog(mapped) : undefined;
        if (dialog) event.dialog = dialog;
        return [event];
      }
      default:
        return [];
    }
  };
}
