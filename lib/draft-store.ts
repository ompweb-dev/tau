export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraftFile {
  name: string;
  mimeType: string;
  content: string;
  size: number;
}

/** A finished upload staged on `hostId` (docs/specs/2026-11-02-file-uploads-design.md U2). */
export interface ChatDraftUpload {
  id: string;
  name: string;
  size: number;
  hostId: string;
  proof?: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  files: ChatDraftFile[];
  /** Recovered model input must not be reinterpreted as a shell command. */
  promptOnly?: boolean;
  /** Finished uploads; unlike images and files their metadata survives a reload. */
  uploads?: ChatDraftUpload[];
}

/** Content to put back in a composer. `replace` merges a later recovery with
 *  an earlier one in order: while the draft still starts with `lead` (the
 *  earlier block), it becomes `text`; otherwise only `fallback` is prepended.
 *  `images` and `files` are appended to the draft's attachments. */
export interface DraftRecovery {
  text: string;
  replace?: { lead: string; fallback: string };
  images?: ChatDraftImage[];
  files?: ChatDraftFile[];
  uploads?: ChatDraftUpload[];
  promptOnly?: boolean;
}

export function mergeRecoveredText(current: string, { text, replace }: DraftRecovery): string {
  if (!text) return current;
  if (replace && current.startsWith(replace.lead)) return text + current.slice(replace.lead.length);
  const lead = replace ? replace.fallback : text;
  return current ? `${lead}\n\n${current}` : lead;
}

// globalThis so dev Fast Refresh doesn't wipe drafts mid-typing.
declare global {
  var __tauChatDrafts: Map<string, ChatDraft> | undefined;
  var __tauChatDraftListeners: Set<() => void> | undefined;
  var __tauChatDraftOwners: Map<string, string> | undefined;
  var __tauChatDraftsFolded: boolean | undefined;
  var __tauChatDraftRecoveryListeners: Set<(key: string, recovery: DraftRecovery) => void> | undefined;
  var __tauChatDraftConsumptionListeners: Set<(key: string, snapshot: ChatDraft) => void> | undefined;
  var __tauChatDraftRevisions: { byKey: Map<string, number>; last: number } | undefined;
  var __tauChatDraftSubmissions: Set<DraftSubmission> | undefined;
}

const MAX_DRAFTS = 50;
const STORAGE_PREFIX = "tau-draft-";
const UPLOADS_STORAGE_PREFIX = "tau-uploads-draft-";
const PROMPT_STORAGE_PREFIX = "tau-prompt-draft-";

function isDraftUpload(value: unknown): value is ChatDraftUpload {
  if (!value || typeof value !== "object") return false;
  const upload = value as Record<string, unknown>;
  return typeof upload.id === "string" && typeof upload.name === "string" && typeof upload.hostId === "string"
    && Number.isSafeInteger(upload.size) && (upload.size as number) >= 0
    && (upload.proof === undefined || typeof upload.proof === "string");
}

const drafts: Map<string, ChatDraft> = (globalThis.__tauChatDrafts ??= readStoredDrafts());

function readStoredDrafts(): Map<string, ChatDraft> {
  const stored = new Map<string, ChatDraft>();
  try {
    // Snapshot keys: removing overflow can change Storage's enumeration order.
    const storageKeys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
    for (const storageKey of storageKeys) {
      if (!storageKey?.startsWith(STORAGE_PREFIX)) continue;
      if (stored.size >= MAX_DRAFTS) {
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(PROMPT_STORAGE_PREFIX + storageKey.slice(STORAGE_PREFIX.length));
        continue;
      }
      const value = sessionStorage.getItem(storageKey);
      if (value) {
        const key = storageKey.slice(STORAGE_PREFIX.length);
        stored.set(key, { value, images: [], files: [], ...(sessionStorage.getItem(PROMPT_STORAGE_PREFIX + key) === "1" ? { promptOnly: true } : {}) });
      } else {
        sessionStorage.removeItem(storageKey);
      }
    }
    // A draft's uploads, under their own key: with its text, or alone.
    for (const storageKey of storageKeys) {
      if (!storageKey?.startsWith(UPLOADS_STORAGE_PREFIX)) continue;
      const key = storageKey.slice(UPLOADS_STORAGE_PREFIX.length);
      let uploads: unknown;
      try {
        uploads = JSON.parse(sessionStorage.getItem(storageKey) ?? "");
      } catch {
        uploads = null;
      }
      const draft = stored.get(key) ?? (stored.size < MAX_DRAFTS ? { value: "", images: [], files: [] } : null);
      if (!draft || !Array.isArray(uploads) || !uploads.every(isDraftUpload) || uploads.length === 0) {
        sessionStorage.removeItem(storageKey);
        continue;
      }
      stored.set(key, { ...draft, uploads });
    }
  } catch {
    // Storage may be unavailable (SSR or browser policy); keep drafts in memory.
  }
  return stored;
}

const listeners = (globalThis.__tauChatDraftListeners ??= new Set<() => void>());
const recoveryListeners = (globalThis.__tauChatDraftRecoveryListeners ??= new Set<(key: string, recovery: DraftRecovery) => void>());
const consumptionListeners = (globalThis.__tauChatDraftConsumptionListeners ??= new Set<(key: string, snapshot: ChatDraft) => void>());
const revisions = (globalThis.__tauChatDraftRevisions ??= { byKey: new Map<string, number>(), last: 0 });
const submissions = (globalThis.__tauChatDraftSubmissions ??= new Set<DraftSubmission>());

export function hasUnsentDrafts(): boolean {
  return drafts.size > 0;
}

/** Whether `key` holds unsent text or attachments (empty drafts are never stored). */
export function hasDraft(key: string): boolean {
  return drafts.has(key);
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function subscribeDraftRecovery(listener: (key: string, recovery: DraftRecovery) => void): () => void {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}

/** Records an edit at input admission, before it reaches `setDraft`: batched React updates can end with the same
 *  content and never write the store, which would otherwise hide a clear-and-retype from `consumeDraft`. */
export function markDraftEdited(key: string): void {
  markSubmissionsEdited(key);
  if (drafts.has(key)) revisions.byKey.set(key, ++revisions.last);
}

/** A submission waiting for its durable commit, owned by this store (not by the composer mount that sent it, which may
 *  be gone by the time the commit lands). `edited` records any edit since it was sent. */
export interface DraftSubmission { key: string | undefined; snapshot: ChatDraft | null; revision: number; edited: boolean }

/** Starts tracking the draft at `key`. Every submission MUST be ended (`endDraftSubmission`) once its commit settles,
 *  whether it was stored, refused or failed. */
export function beginDraftSubmission(key: string | undefined): DraftSubmission {
  const submission: DraftSubmission = { key, snapshot: key ? getDraft(key) : null, revision: key ? getDraftRevision(key) : -1, edited: false };
  submissions.add(submission);
  return submission;
}

export function endDraftSubmission(submission: DraftSubmission): void {
  submissions.delete(submission);
}

function markSubmissionsEdited(key: string): void {
  for (const submission of submissions) if (submission.key === key) submission.edited = true;
}

/** Edit generation of a key's draft: bumps on every content change (not on a same-content rewrite such as hydration or
 *  a navigation save), so a clear-and-retype of equal text is a different revision. -1 when there is no draft; a draft
 *  restored from sessionStorage and never edited since is 0. */
export function getDraftRevision(key: string): number {
  return drafts.has(key) ? revisions.byKey.get(key) ?? 0 : -1;
}

// Attachment payloads disappear on reload; keep a bang-prefixed prompt from turning into shell input with them.
export function requiresPromptMode(draft: ChatDraft): boolean {
  return draft.promptOnly === true || (draft.value.trimStart().startsWith("!")
    && (draft.images.length > 0 || draft.files.length > 0 || Boolean(draft.uploads?.length)));
}

/** Content equality by field, without re-encoding attachment payloads; absent and empty `uploads` are equal. */
export function isSameDraft(a: ChatDraft | undefined, b: ChatDraft): boolean {
  if (!a || a.value !== b.value || requiresPromptMode(a) !== requiresPromptMode(b) || a.images.length !== b.images.length || a.files.length !== b.files.length) return false;
  const uploadsA = a.uploads ?? [];
  const uploadsB = b.uploads ?? [];
  return uploadsA.length === uploadsB.length
    && a.images.every((image, i) => image.data === b.images[i].data && image.mimeType === b.images[i].mimeType)
    && a.files.every((file, i) => file.name === b.files[i].name && file.mimeType === b.files[i].mimeType && file.content === b.files[i].content && file.size === b.files[i].size)
    && uploadsA.every((upload, i) => upload.id === uploadsB[i].id && upload.name === uploadsB[i].name && upload.size === uploadsB[i].size && upload.hostId === uploadsB[i].hostId && upload.proof === uploadsB[i].proof);
}

/** A durable outbox commit consumes only the draft it was sent from: the same edit revision AND unchanged content
 *  (also after a composer remount). Any later edit, even one that restores the same text, keeps the draft. */
export function consumeDraft(key: string, snapshot: ChatDraft, revision: number): void {
  if (getDraftRevision(key) !== revision || !isSameDraft(drafts.get(key), snapshot)) return;
  clearDraft(key);
  for (const listener of consumptionListeners) listener(key, snapshot);
}

export function subscribeDraftConsumption(listener: (key: string, snapshot: ChatDraft) => void): () => void {
  consumptionListeners.add(listener);
  return () => { consumptionListeners.delete(listener); };
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    files: draft.files.map((file) => ({ ...file })),
    ...(requiresPromptMode(draft) ? { promptOnly: true } : {}),
    ...(draft.uploads?.length ? { uploads: draft.uploads.map((upload) => ({ ...upload })) } : {}),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && draft.files.length === 0 && !draft.uploads?.length;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

/** The draft key each chat's mounted composer shows (`holdDraftOwner`), by chat. */
const liveOwners = (globalThis.__tauChatDraftOwners ??= new Map<string, string>());

/** Records that `owner`'s composer shows `key` until the returned release runs. */
export function holdDraftOwner(owner: string, key: string): () => void {
  liveOwners.set(owner, key);
  return () => {
    if (liveOwners.get(owner) === key) liveOwners.delete(owner);
  };
}

const SENT_KEY_MARK = "#sent:";

/** A new chat's draft key of its own once it sent, over its workspace's `base`, until its session takes over. */
function sentDraftBase(key: string): string {
  return key.slice(0, key.lastIndexOf(SENT_KEY_MARK));
}

export function sentDraftKey(base: string, chat: string): string {
  return `${base}${SENT_KEY_MARK}${chat}`;
}

// The exact shape at the end of the key (a chat id is base36): `#` is legal in a workspace path.
const SENT_KEY_RE = /#sent:[0-9a-z]{12,}$/;

export function isSentDraftKey(key: string): boolean {
  return SENT_KEY_RE.test(key);
}

/** A `sentDraftKey`'s draft goes back to its workspace's (its chat is gone, or the page was reloaded): recovered into
 *  it as into any composer, so a new chat showing it gets the text too. */
export function foldSentDraft(key: string): void {
  const draft = getDraft(key);
  clearDraft(key);
  if (draft) recoverDraft(sentDraftBase(key), { text: draft.value, images: draft.images.length ? draft.images : undefined, files: draft.files.length ? draft.files : undefined, uploads: draft.uploads, ...(draft.promptOnly ? { promptOnly: true } : {}) });
}

/** Recovers into `key`'s draft or, when `owner`'s composer is mounted, into the draft it shows now: a new chat that
 *  sent moves to a key of its own, and another chat may have its old one. */
export function recoverDraft(key: string, recovery: DraftRecovery, owner?: string): void {
  if (!recovery.text && !recovery.images?.length && !recovery.files?.length && !recovery.uploads?.length) return;
  key = (owner && liveOwners.get(owner)) || key;
  // A chat's own key that no composer shows any more (its chat went away): its workspace's draft takes it.
  if (isSentDraftKey(key) && ![...liveOwners.values()].includes(key)) key = sentDraftBase(key);
  if (key) {
    const draft = getDraft(key) ?? { value: "", images: [], files: [] };
    setDraft(key, {
      ...draft,
      value: mergeRecoveredText(draft.value, recovery),
      images: [...draft.images, ...(recovery.images ?? [])],
      files: [...draft.files, ...(recovery.files ?? [])],
      ...((draft.promptOnly || recovery.promptOnly) ? { promptOnly: true } : {}),
      uploads: [...(draft.uploads ?? []), ...(recovery.uploads ?? [])],
    });
  }
  // Publish the recovery intent separately: ordinary persistence must not
  // reapply it, and the mounted composer may have React updates still queued.
  for (const listener of recoveryListeners) listener(key, recovery);
}

export function getDraftSummary(key: string): { text: string; hasAttachments: boolean } {
  const draft = drafts.get(key);
  if (!draft) return { text: "", hasAttachments: false };
  return {
    text: draft.value,
    hasAttachments: draft.images.length > 0 || draft.files.length > 0 || Boolean(draft.uploads?.length),
  };
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return;
  }
  if (drafts.size >= MAX_DRAFTS && !drafts.has(key)) {
    const oldestKey = drafts.keys().next().value;
    if (oldestKey !== undefined) clearDraft(oldestKey);
  }
  const next = cloneDraft(draft);
  if (!isSameDraft(drafts.get(key), next)) {
    revisions.byKey.set(key, ++revisions.last);
    markSubmissionsEdited(key);
  }
  drafts.set(key, next);
  try {
    // Persist only text: attachment payloads can exhaust the tab's storage quota.
    // Mark prompt provenance before publishing its text; never restore that text as a shell command after reload.
    if (next.promptOnly) sessionStorage.setItem(PROMPT_STORAGE_PREFIX + key, "1");
    if (draft.value) sessionStorage.setItem(STORAGE_PREFIX + key, draft.value);
    else sessionStorage.removeItem(STORAGE_PREFIX + key);
    if (!next.promptOnly) sessionStorage.removeItem(PROMPT_STORAGE_PREFIX + key);
    if (draft.uploads?.length) sessionStorage.setItem(UPLOADS_STORAGE_PREFIX + key, JSON.stringify(draft.uploads));
    else sessionStorage.removeItem(UPLOADS_STORAGE_PREFIX + key);
  } catch {
    // Preserve the in-memory draft if storage is unavailable or full.
  }
  for (const listener of listeners) listener();
}

export function clearDraft(key: string): void {
  const deleted = drafts.delete(key);
  revisions.byKey.delete(key);
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + key);
    sessionStorage.removeItem(UPLOADS_STORAGE_PREFIX + key);
    sessionStorage.removeItem(PROMPT_STORAGE_PREFIX + key);
  } catch {
    // Storage may be unavailable.
  }
  if (deleted) {
    for (const listener of listeners) listener();
  }
}

// A reload reopens no chat's own key: their drafts are their workspaces' again (once per page, not per hot reload).
if (!globalThis.__tauChatDraftsFolded) {
  globalThis.__tauChatDraftsFolded = true;
  for (const key of [...drafts.keys()]) if (isSentDraftKey(key)) foldSentDraft(key);
}
