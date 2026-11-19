import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ChatInput } = await import("./ChatInput.tsx");
const { clearDraft, getDraft, setDraft } = await import("@/lib/draft-store");

const KEY = "queue-attachments";
// 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Same stand-in as ChatInput.clipboard-image.test.mjs: jsdom's FileReader
// brand-checks against its own realm's Blob; the composer only needs
// readAsDataURL -> `result`.
const previousFileReader = globalThis.FileReader;
class TestFileReader {
  result = null;
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      },
      (error) => this.onerror?.(error),
    );
  }
}

const overrides = [];
function override(target, key, replacement) {
  overrides.push({ target, key, original: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
}

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.FileReader = TestFileReader;
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  try {
    cleanup();
  } finally {
    clearDraft(KEY);
    localStorage.clear();
    delete window.matchMedia;
    globalThis.FileReader = previousFileReader;
    while (overrides.length) {
      const { target, key, original } = overrides.pop();
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
  }
});

/** A composer with an image and a text file attached through the picker path. */
async function renderWithAttachments({ queued = true, queueCallbacks = true, ...props } = {}) {
  const calls = [];
  // Images follow the message in every callback; `onSend` carries options after them when text files are attached.
  // The callback resolves false when omp refused the message.
  const record = (name) => async (message, ...rest) => {
    calls.push({ name, message, images: rest[0] });
    const ok = await queued;
    return name === "onSend" ? { status: ok ? "accepted" : "rejected" } : ok;
  };
  const ref = React.createRef();
  const inputProps = {
    ref,
    draftKey: KEY,
    isStreaming: true,
    onSend: record("onSend"),
    onAbort: record("onAbort"),
    onSteer: queueCallbacks ? record("onSteer") : undefined,
    onFollowUp: queueCallbacks ? record("onFollowUp") : undefined,
    ...props,
  };
  const view = render(React.createElement(ChatInput, inputProps));
  await act(async () => {
    ref.current.addFiles([
      new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" }),
      new File(["hello"], "notes.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => {
    const draft = getDraft(KEY);
    assert.equal(draft?.images.length, 1, "the image is attached");
    assert.equal(draft?.files.length, 1);
  });
  return {
    calls,
    ref,
    rerender: (changes) => view.rerender(React.createElement(ChatInput, { ...inputProps, ...changes })),
  };
}

async function renderRunningWithAttachments(options) {
  return (await renderWithAttachments(options)).calls;
}

function assertQueuedWithAttachments(call, text) {
  assert.ok(call.message.startsWith(text), "typed text leads the message");
  assert.match(call.message, /Attached file: notes\.txt\n```[^\n]*\nhello\n```/, "text file is folded in");
  assert.deepEqual(call.images?.map((image) => [image.data, image.mimeType]), [[PNG, "image/png"]]);
}

test("Enter during a run queues a follow-up with the attached image and text file, then clears them", async () => {
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  // Queueing is the default submit-during-run behavior: it is what survives a
  // `!!` shell command owning the session (see lib/rpc-manager.ts).
  assert.equal(calls[0].name, "onFollowUp", "the default submit-during-run behavior queues");
  assertQueuedWithAttachments(calls[0], "look at this");
  await waitFor(() => assert.equal(getDraft(KEY), null));
});

test("a stored Steer preference still steers Enter during a run", async () => {
  localStorage.setItem("tau:submit-during-run", "steer");
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onSteer", "an explicit stored choice stays a steer");
  assertQueuedWithAttachments(calls[0], "look at this");
});

test("attachments alone turn Stop into Queue, which queues them as a follow-up", async () => {
  const calls = await renderRunningWithAttachments();
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onFollowUp");
  assertQueuedWithAttachments(calls[0], "Attached file:");
});

test("a stored Steer preference turns the primary button into Steer, which steers like Enter", async () => {
  localStorage.setItem("tau:submit-during-run", "steer");
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "look at this");
  assert.equal(Boolean(screen.queryByRole("button", { name: /^queue$/i })), false, "the button no longer claims to queue");
  const steer = screen.getByRole("button", { name: /^steer$/i });
  assert.equal(steer.title, "Interrupt the current run and inject this message now");
  fireEvent.click(steer);
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].name, "onSteer", "touch devices without Enter can steer");
  assertQueuedWithAttachments(calls[0], "look at this");
});

test("a queued web slash command is expanded and keeps the attachments", async () => {
  const { expandWebSlashCommand } = await import("@/lib/web-slash-commands");
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const user = userEvent.setup();
  const calls = await renderRunningWithAttachments();
  await user.type(screen.getByRole("textbox"), "/goal ship it");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(calls.length, 1));
  delete window.HTMLElement.prototype.scrollIntoView;
  assert.equal(calls[0].name, "onFollowUp", "a slash command is held like any follow-up; the server sends it as a prompt");
  assertQueuedWithAttachments(calls[0], expandWebSlashCommand("/goal ship it").prompt);
});

test("a queued message stays in the composer until the outbox has it, and stays whole when refused", async () => {
  let refuse;
  const calls = await renderRunningWithAttachments({ queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }], "not cleared before it is stored");
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  assert.equal(calls.length, 1, "a second click while it is being stored sends nothing");
  await act(async () => { refuse(); });
  assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }], "a refusal leaves text and attachments in place");
  assert.equal(getDraft(KEY)?.files.length, 1);
});

test("a queued message is not cleared once stored if the composer changed meanwhile", async () => {
  let store;
  const calls = await renderRunningWithAttachments({ queued: new Promise((resolve) => { store = () => resolve(true); }) });
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed meanwhile" } });
  await act(async () => { store(); });
  assert.equal(screen.getByRole("textbox").value, "typed meanwhile");
});

test("an outbox commit after unmount cannot clear a remounted composer's new text or attachments", async () => {
  let store;
  const calls = await renderRunningWithAttachments({ queued: new Promise((resolve) => { store = () => resolve(true); }) });
  fireEvent.click(screen.getByRole("button", { name: /queue/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  cleanup();
  render(React.createElement(ChatInput, { draftKey: KEY, outbox: true, isStreaming: false, onAbort() {}, onSend: async () => ({ status: "accepted" }) }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "new draft after remount" } });
  await act(async () => { store(); });
  assert.equal(screen.getByRole("textbox").value, "new draft after remount");
  assert.equal(getDraft(KEY)?.value, "new draft after remount");
  assert.equal(getDraft(KEY)?.images.length, 1);
  assert.equal(getDraft(KEY)?.files.length, 1);
});

// A text-only outbox Send whose IndexedDB commit is still pending; `store()` completes it.
async function sendTextPendingStore(text) {
  let store;
  const onSend = () => new Promise((resolve) => { store = () => resolve({ status: "accepted" }); });
  const ref = React.createRef();
  const props = { ref, draftKey: KEY, outbox: true, isStreaming: false, onAbort() {}, onSend };
  const view = render(React.createElement(ChatInput, props));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => assert.ok(store, "the send reached the outbox"));
  return { props, ref, view, store: () => act(async () => { store(); }) };
}

test("an equal-text clear-and-retype while the outbox commit is pending is newer input and survives", async () => {
  const { store } = await sendTextPendingStore("same text");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
  await store();
  assert.equal(screen.getByRole("textbox").value, "same text");
  assert.equal(getDraft(KEY)?.value, "same text");
});

test("an equal-text clear-and-retype in a remounted composer survives the original commit", async () => {
  const { props, store } = await sendTextPendingStore("same text");
  cleanup();
  render(React.createElement(ChatInput, props));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "same text" } });
  await store();
  assert.equal(screen.getByRole("textbox").value, "same text");
  assert.equal(getDraft(KEY)?.value, "same text");
});
// A controlled textarea's DOM events flush synchronously (React restores controlled state at event end), so a DOM
// clear-and-retype always reaches the persist effect; only programmatic inputs (dictation, history, completions, the
// imperative handle) can be batched into an unflushed edit whose final value equals the sent one, and React then
// bails so the persist effect never writes the store. The edit recorded at input admission is what tells the pending
// commit its composer was touched. The sent message here is attachment-only, so its text is "".
async function sendAttachmentOnlyPendingStore() {
  let store;
  const ref = React.createRef();
  const props = {
    ref, draftKey: KEY, outbox: true, isStreaming: false, onAbort() {},
    onSend: () => new Promise((resolve) => { store = () => resolve({ status: "accepted" }); }),
  };
  render(React.createElement(ChatInput, props));
  await act(async () => { ref.current.addFiles([new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" })]); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
  await waitFor(() => assert.ok(store, "the send reached the outbox"));
  return { props, ref, store: () => act(async () => { store(); }) };
}
const programmaticEditEndingEqual = (ref) => act(async () => {
  ref.current.insertIfEmpty("tmp");
  ref.current.insertIfEmpty("");
});

test("a programmatic edit batched back to the sent text keeps the composer through the original commit", async () => {
  const { ref, store } = await sendAttachmentOnlyPendingStore();
  await programmaticEditEndingEqual(ref);
  await store();
  assert.equal(getDraft(KEY)?.images.length, 1, "touched composer is not consumed");
});

test("the same batched programmatic edit in a remounted composer keeps it through the original commit", async () => {
  const { props, store } = await sendAttachmentOnlyPendingStore();
  cleanup();
  const ref = React.createRef();
  render(React.createElement(ChatInput, { ...props, ref }));
  await programmaticEditEndingEqual(ref);
  await store();
  assert.equal(getDraft(KEY)?.images.length, 1, "touched composer is not consumed");
});


for (const image of [false, true]) {
  test(`a newly admitted ${image ? "image" : "text file"} read survives the older send's ACK before the read completes`, async (t) => {
    const { ref, store } = await sendTextPendingStore("same text");
    let release;
    const content = image ? Uint8Array.from(Buffer.from(PNG, "base64")).buffer : "new file";
    const file = new File([image ? Buffer.from(PNG, "base64") : content], image ? "new.png" : "new.txt", {
      type: image ? "image/png" : "text/plain",
    });
    override(file, image ? "arrayBuffer" : "text", () => new Promise((resolve) => { release = resolve; }));
    t.after(() => release?.(content));
    act(() => { ref.current.addFiles([file]); });
    assert.equal(typeof release, "function", "the file was accepted and its read started");
    await store();
    await act(async () => { release(content); });
    await waitFor(() => assert.equal(image ? getDraft(KEY)?.images.length : getDraft(KEY)?.files.length, 1));
    assert.equal(screen.getByRole("textbox").value, "same text", "the newer attachment intent keeps the composer");
  });
}

test("an untouched remounted draft, and one only navigated away and back, is consumed by its commit", async () => {
  const { props, store } = await sendTextPendingStore("same text");
  cleanup();
  const view = render(React.createElement(ChatInput, props));
  assert.equal(screen.getByRole("textbox").value, "same text", "hydrated, not typed");
  view.rerender(React.createElement(ChatInput, { ...props, draftKey: `${KEY}:elsewhere` }));
  view.rerender(React.createElement(ChatInput, props));
  assert.equal(screen.getByRole("textbox").value, "same text");
  await store();
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(getDraft(KEY), null);
});

for (const stored of [true, false]) {
  test(`an idle Send through the outbox clears only once ${stored ? "stored" : "refused: never"}`, async () => {
    let answer;
    const user = userEvent.setup();
    const calls = await renderRunningWithAttachments({ isStreaming: false, outbox: true, queued: new Promise((resolve) => { answer = resolve; }) });
    await user.type(screen.getByRole("textbox"), "look at this");
    await user.keyboard("{Enter}");
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].name, "onSend");
    assert.equal(getDraft(KEY)?.images.length, 1, "kept until the outbox has it");
    await act(async () => { answer(stored); });
    if (stored) await waitFor(() => assert.equal(getDraft(KEY), null));
    else {
      assert.equal(screen.getByRole("textbox").value, "look at this");
      assert.equal(getDraft(KEY)?.images.length, 1);
    }
  });
}

for (const { label, fill, oversized } of [
  { label: "sendable composed request", fill: "x", oversized: false },
  { label: "oversized composed request", fill: '"', oversized: true },
]) {
  test(`merged text drafts past picker count and byte budgets survive persistence and remount (${label})`, async () => {
    const {
      MAX_ATTACHED_TEXT_FILES, MAX_TOTAL_ATTACHED_TEXT_BYTES, selectTextAttachments,
    } = await import("@/lib/chat-attachments");
    const count = Math.floor(MAX_ATTACHED_TEXT_FILES / 2) + 1;
    const fileBytes = Math.floor(MAX_TOTAL_ATTACHED_TEXT_BYTES * 0.75 / count);
    const makeFiles = (origin) => Array.from({ length: count }, (_, index) => {
      const name = `${origin}-${index}.txt`;
      const content = `${name}\n${fill.repeat(fileBytes - name.length - 1)}`;
      return { name, mimeType: "text/plain", content, size: Buffer.byteLength(content) };
    });
    const sourceFiles = makeFiles("source");
    const targetFiles = makeFiles("target");
    for (const files of [sourceFiles, targetFiles]) {
      assert.deepEqual(selectTextAttachments(files, { usedBytes: 0, usedSlots: 0 }).accepted, files,
        "each pre-relocation draft fits the unchanged picker limits");
    }
    // Seed the source + existing-target merge supplied by Edit relocation;
    // exercise the real composer hydration and persistence, not the hook here.
    const files = [...sourceFiles, ...targetFiles];
    assert.ok(files.length > MAX_ATTACHED_TEXT_FILES);
    assert.ok(files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHED_TEXT_BYTES);
    const images = [{ data: PNG, mimeType: "image/png" }, { data: PNG, mimeType: "image/png" }];
    const initialValue = "recovered edit\n\npre-existing target";
    setDraft(KEY, { value: initialValue, images, files });
    const calls = [];
    const mount = () => render(React.createElement(ChatInput, {
      draftKey: KEY, isStreaming: false, onAbort() {},
      onSend: async (message, sentImages) => {
        calls.push({ message, images: sentImages });
        return { status: "accepted" };
      },
    }));
    const assertRecovered = (value) => {
      assert.deepEqual(getDraft(KEY), { value, images, files }, "every file retains its exact contents in the persisted draft");
      assert.equal(screen.getByRole("textbox").value, value);
      for (const file of files) assert.equal(screen.getByTitle(file.name).textContent, file.name);
      assert.equal(document.querySelectorAll("img").length, images.length);
    };
    let view = mount();
    assertRecovered(initialValue);
    const newerValue = `${initialValue}\nnewer typing`;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: newerValue } });
    assertRecovered(newerValue);
    view.unmount();
    view = mount();
    assertRecovered(newerValue);

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    if (oversized) {
      // JSON escaping makes these individually picker-valid files exceed the
      // outgoing request budget. The guard must reject without clearing them.
      assert.match((await screen.findByRole("alert")).textContent, /too large to send/i);
      assert.deepEqual(calls, []);
      assertRecovered(newerValue);
      view.unmount();
      mount();
      assertRecovered(newerValue);
    } else {
      await waitFor(() => assert.equal(calls.length, 1));
      const expectedMessage = [newerValue, ...files.map((file) => `Attached file: ${file.name}\n\`\`\`text\n${file.content}\n\`\`\``)].join("\n\n");
      assert.equal(calls[0].message, expectedMessage, "sending includes every source and target file, despite the picker caps");
      assert.deepEqual(calls[0].images.map(({ data, mimeType }) => ({ data, mimeType })), images);
      await waitFor(() => assert.equal(getDraft(KEY), null));
    }
  });
}

test("malformed recovered text files are filtered without discarding valid neighboring files", () => {
  const valid = { name: "valid.txt", mimeType: "text/plain", content: "keep exactly", size: 12 };
  setDraft(KEY, {
    value: "recovered", images: [],
    files: [null, {}, { ...valid, content: null }, { ...valid, size: -1 }, { ...valid, size: Infinity }, valid],
  });
  render(React.createElement(ChatInput, {
    draftKey: KEY, isStreaming: false, onAbort() {}, onSend: async () => ({ status: "accepted" }),
  }));
  assert.deepEqual(getDraft(KEY)?.files, [valid]);
  assert.equal(screen.getByTitle(valid.name).textContent, valid.name);
});

test("recovered images past the attachment cap all stay in the composer", async () => {
  const { MAX_ATTACHED_IMAGES } = await import("@/lib/image-attachments");
  const { recoverDraft } = await import("@/lib/draft-store");
  await renderRunningWithAttachments();
  const recovered = Array.from({ length: MAX_ATTACHED_IMAGES }, () => ({ data: PNG, mimeType: "image/png" }));
  await act(async () => { recoverDraft(KEY, { text: "", images: recovered }); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, MAX_ATTACHED_IMAGES + 1));
  assert.equal(document.querySelectorAll("img").length >= MAX_ATTACHED_IMAGES + 1, true, "every image has a preview to remove");
});

// Keep the real useDictation hook: only browser capture and the STT job API
// are controlled. Polls expose status; only the owner's claim returns text
// and the send intent, matching the server job boundary.
function installPendingDictation({ holdUpload = false, holdClaim = false, after = "send" } = {}) {
  const uploads = [];
  const polls = [];
  const claims = [];
  let done = false;
  const recorders = [];
  let trackStops = 0;
  let releaseUpload;
  const uploadReady = holdUpload ? new Promise((resolve) => { releaseUpload = resolve; }) : Promise.resolve();
  let releaseClaim;
  const claimReady = holdClaim ? new Promise((resolve) => { releaseClaim = resolve; }) : Promise.resolve();
  class TestMediaRecorder {
    state = "inactive";
    mimeType = "audio/webm";
    constructor() { recorders.push(this); }
    start() { this.state = "recording"; }
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    requestData() {
      this.ondataavailable?.({ data: new Blob(["spoken audio"], { type: this.mimeType }) });
    }
    stop() {
      this.state = "inactive";
      this.requestData();
      this.onstop?.();
    }
  }
  override(navigator, "mediaDevices", {
    getUserMedia: async () => ({ getTracks: () => [{ stop() { trackStops += 1; } }] }),
  });
  override(window, "MediaRecorder", TestMediaRecorder);
  override(globalThis, "MediaRecorder", TestMediaRecorder);
  override(globalThis, "Audio", class {
    paused = true;
    currentTime = 0;
    duration = 1;
    constructor(src) { this.src = src; }
    pause() { this.paused = true; this.onpause?.(); }
    async play() { this.paused = false; this.onplay?.(); }
  });
  // jsdom has no canvas renderer; waveform drawing is outside this regression.
  override(window.HTMLCanvasElement.prototype, "getContext", () => null);
  const response = (body, status = 200) => ({ ok: true, status, json: async () => body });
  override(globalThis, "fetch", async (url, init) => {
    const target = new URL(url, window.location.href);
    const method = init?.method ?? "GET";
    if (target.pathname === "/api/stt" && method === "GET" && target.searchParams.has("scope")) {
      return response({ jobs: [] });
    }
    if (target.pathname === "/api/stt" && method === "POST") {
      uploads.push({
        after: init.body.get("after"),
        owner: init.body.get("owner"),
        scope: init.body.get("scope"),
        file: init.body.get("file"),
      });
      await uploadReady;
      return response({ jobId: "edit-pending-job" }, 202);
    }
    if (target.pathname === "/api/stt/edit-pending-job" && method === "GET") {
      const status = done ? "done" : "pending";
      polls.push(status);
      return response({ status });
    }
    if (target.pathname === "/api/stt/edit-pending-job" && method === "DELETE" && target.searchParams.has("claim")) {
      const claim = { token: target.searchParams.get("claim"), owner: target.searchParams.get("owner") };
      claims.push(claim);
      await claimReady;
      return response({
        status: "done",
        text: "transcribed words",
        after: claim.owner === uploads[0]?.owner ? after : undefined,
      });
    }
    throw new Error(`Unexpected dictation request: ${method} ${url}`);
  });
  return {
    uploads, polls, claims, recorders,
    get trackStops() { return trackStops; },
    releaseUpload: () => releaseUpload?.(),
    releaseClaim: () => releaseClaim?.(),
    complete: () => { done = true; },
  };
}

for (const isStreaming of [false, true]) {
  for (const edit of ["unchanged", "newer text", "equal-text retype"]) {
    test(`automatic dictated ${isStreaming ? "queue" : "send"} ${edit === "unchanged" ? "clears after durable acceptance" : `preserves ${edit} through delayed acceptance`}`, async () => {
      const dictation = installPendingDictation({ after: isStreaming ? "followup" : "send" });
      const user = userEvent.setup();
      let accept;
      const stored = new Promise((resolve) => { accept = resolve; });
      const submissions = [];
      const submit = (name) => async (message, images) => {
        submissions.push({ name, message, images });
        await stored;
        return name === "onSend" ? { status: "accepted" } : true;
      };
      await renderWithAttachments({
        outbox: true,
        isStreaming,
        queueCallbacks: isStreaming,
        onSend: submit("onSend"),
        ...(isStreaming ? { onFollowUp: submit("onFollowUp") } : {}),
      });
      await user.type(screen.getByRole("textbox"), "draft prefix");
      await user.click(screen.getByRole("button", { name: "Start dictation" }));
      await user.click(isStreaming
        ? screen.getByRole("button", { name: /^queue$/i })
        : await screen.findByTitle("Transcribe and send"));
      await waitFor(() => assert.equal(dictation.uploads.length, 1));
      dictation.complete();
      await waitFor(() => assert.equal(submissions.length, 1), { timeout: 3000 });
      assert.equal(submissions[0].name, isStreaming ? "onFollowUp" : "onSend");
      assertQueuedWithAttachments(submissions[0], "draft prefix transcribed words");
      const textbox = screen.getByRole("textbox");
      assert.equal(textbox.value, "draft prefix transcribed words", "the draft remains until storage accepts it");
      assert.equal(getDraft(KEY)?.images.length, 1);
      assert.equal(getDraft(KEY)?.files.length, 1);
      if (edit !== "unchanged") {
        fireEvent.change(textbox, { target: { value: "" } });
        fireEvent.change(textbox, { target: { value: edit === "newer text" ? "typed after dictation" : "draft prefix transcribed words" } });
      }
      const beforeAcceptance = getDraft(KEY);
      await act(async () => { accept(); await stored; });
      if (edit === "unchanged") {
        assert.equal(textbox.value, "", "durably stored dictation must not remain available to submit again");
        assert.equal(getDraft(KEY), null, "the sent draft and its attachments are consumed");
        assert.equal(screen.queryByRole("button", { name: /remove image/i }), null);
        assert.equal(screen.queryByTitle("notes.txt"), null);
      } else {
        assert.equal(textbox.value, beforeAcceptance.value);
        assert.deepEqual(getDraft(KEY), beforeAcceptance, "the newer draft retains its text and both attachments");
      }
      assert.equal(submissions.length, 1, "storage completion never resubmits");
    });
  }
}

for (const { label, queueCallbacks } of [
  { label: "idle composer", queueCallbacks: false },
  { label: "queue callbacks available", queueCallbacks: true },
]) {
  test(`an after:send transcript finishing during Edit stays in the draft until explicit send (${label})`, async () => {
    const dictation = installPendingDictation();
    const user = userEvent.setup();
    const { calls, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks });
    await user.type(screen.getByRole("textbox"), "keep this draft");
    const beforeTranscript = getDraft(KEY);

    await user.click(screen.getByRole("button", { name: "Start dictation" }));
    await user.click(await screen.findByTitle("Transcribe and send"));
    await waitFor(() => assert.equal(dictation.uploads.length, 1));
    const [upload] = dictation.uploads;
    assert.equal(upload.after, "send", "the real hook uploads the chosen completion action");
    assert.equal(upload.scope, KEY);
    assert.ok(upload.owner);
    assert.equal(upload.file.type, "audio/webm");
    assert.ok(upload.file.size > 0, "audio crosses the recorder/upload boundary");
    await waitFor(() => assert.equal(dictation.polls[0], "pending"), { timeout: 3000 });

    // Edit is not a model run: leave isStreaming false while the job completes.
    rerender({ submissionBlocked: true });
    dictation.complete();
    const finalText = "keep this draft transcribed words";
    const expectedDraft = { ...beforeTranscript, value: finalText };
    await waitFor(() => {
      assert.equal(screen.getByRole("textbox").value, finalText);
      assert.deepEqual(getDraft(KEY), expectedDraft, "text, image and text-file attachments survive");
    }, { timeout: 3000 });
    assert.equal(dictation.claims.length, 1, "delivery comes through the real hook's claim request");
    assert.ok(dictation.claims[0].token);
    assert.equal(dictation.claims[0].owner, upload.owner);
    assert.deepEqual(calls, [], "neither a prompt nor any queue callback may run while Edit is pending");
    assert.equal(screen.getByRole("button", { name: /^send$/i }).disabled, true);

    if (!queueCallbacks) {
      await user.click(screen.getByRole("textbox"));
      await user.keyboard("{Enter}");
      assert.deepEqual(calls, [], "keyboard submit also respects the pending Edit");
      assert.equal(screen.getByRole("textbox").value, finalText);
      assert.deepEqual(getDraft(KEY), expectedDraft);
    }

    rerender({ submissionBlocked: false });
    assert.deepEqual(calls, [], "unblocking must not replay the saved automatic send choice");
    assert.equal(screen.getByRole("button", { name: /^send$/i }).disabled, false);
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].name, "onSend");
    assertQueuedWithAttachments(calls[0], finalText);
    await waitFor(() => assert.equal(getDraft(KEY), null));
    assert.equal(screen.getByRole("textbox").value, "");
  });
}

test("an image-only send refused by another tab's Edit returns its attachment", async () => {
  const ref = React.createRef();
  const calls = [];
  render(React.createElement(ChatInput, {
    ref, draftKey: KEY, isStreaming: false, onAbort() {},
    onSend: async (message, images) => { calls.push({ message, images }); return { status: "rejected" }; },
  }));
  await act(async () => { ref.current.addFiles([new File([Buffer.from(PNG, "base64")], "dot.png", { type: "image/png" })]); });
  await waitFor(() => assert.equal(getDraft(KEY)?.images.length, 1));
  await userEvent.setup().click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0].message, "");
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(document.querySelectorAll("img").length, 1, "the restored image is visible, not merely stored");
});

test("a refused ordinary send restores text, file contents and images ahead of newer typing", async () => {
  let refuse;
  const user = userEvent.setup();
  const { calls } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false, queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  const originalFiles = getDraft(KEY).files;
  await user.type(screen.getByRole("textbox"), "original question");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  await user.type(screen.getByRole("textbox"), "typed meanwhile");
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY).value, "original question\n\ntyped meanwhile");
  assert.deepEqual(getDraft(KEY).files, originalFiles);
  assert.equal(screen.getByRole("textbox").value, getDraft(KEY).value);
  assertQueuedWithAttachments(calls[0], "original question");
});

test("a refused ordinary send recovers only into its originating session draft", async (t) => {
  const otherKey = "ordinary-send-other-session";
  t.after(() => clearDraft(otherKey));
  let refuse;
  const user = userEvent.setup();
  const { calls, rerender } = await renderWithAttachments({ isStreaming: false, queueCallbacks: false, queued: new Promise((resolve) => { refuse = () => resolve(false); }) });
  const originalFiles = getDraft(KEY).files;
  await user.type(screen.getByRole("textbox"), "original session");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(calls.length, 1));
  rerender({ draftKey: otherKey });
  await user.type(screen.getByRole("textbox"), "other conversation");
  await act(async () => { refuse(); });
  await waitFor(() => assert.deepEqual(getDraft(KEY)?.images, [{ data: PNG, mimeType: "image/png" }]));
  assert.equal(getDraft(KEY).value, "original session");
  assert.deepEqual(getDraft(KEY).files, originalFiles);
  assert.equal(screen.getByRole("textbox").value, "other conversation");
  assert.equal(getDraft(otherKey).value, "other conversation");
  assert.deepEqual(getDraft(otherKey).images, []);
});

test("a refused first send follows its promoted conversation rather than the old new-chat draft", async (t) => {
  const promotedKey = "promoted-first-send";
  t.after(() => clearDraft(promotedKey));
  let refuse;
  const submitted = [];
  const { rerender } = await renderWithAttachments({
    isStreaming: false, queueCallbacks: false,
    onSend: async (message) => { submitted.push(message); return new Promise((resolve) => { refuse = () => resolve({ status: "rejected", recoveryKey: promotedKey }); }); },
  });
  const originalFiles = getDraft(KEY).files;
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), "first question");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(submitted.length, 1));
  rerender({ draftKey: promotedKey });
  await act(async () => { refuse(); });
  await waitFor(() => assert.equal(getDraft(promotedKey)?.value, "first question"));
  assert.deepEqual(getDraft(promotedKey).images, [{ data: PNG, mimeType: "image/png" }]);
  assert.deepEqual(getDraft(promotedKey).files, originalFiles);
  assert.equal(screen.getByRole("textbox").value, "first question");
  assert.equal(getDraft(KEY), null, "the original new-chat draft must not resurrect this payload later");
});

test("a superseded send result cannot restore a prompt that was already processed", async () => {
  let supersede;
  const submitted = [];
  await renderWithAttachments({
    isStreaming: false, queueCallbacks: false,
    onSend: async (message) => { submitted.push(message); return new Promise((resolve) => { supersede = () => resolve({ status: "superseded" }); }); },
  });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox"), "already processed");
  await user.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => assert.equal(submitted.length, 1));
  await user.type(screen.getByRole("textbox"), "next draft");
  await act(async () => { supersede(); });
  assert.equal(screen.getByRole("textbox").value, "next draft");
  assert.equal(getDraft(KEY).value, "next draft");
  assert.deepEqual(getDraft(KEY).images, []);
});

test("a second Enter must not invoke a pending slash builtin twice; success clears unchanged text", async (t) => {
  override(window.HTMLElement.prototype, "scrollIntoView", () => {});
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  t.after(async () => { await act(async () => { finish({ handled: true }); }); });
  const builtinCalls = [];
  const user = userEvent.setup();
  render(React.createElement(ChatInput, {
    draftKey: KEY,
    isStreaming: false,
    onAbort() {},
    onSend: async () => ({ status: "accepted" }),
    onBuiltinCommand: (message) => {
      builtinCalls.push(message);
      return pending;
    },
  }));
  const textbox = screen.getByRole("textbox");
  await user.type(textbox, "/goal ship it");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.equal(builtinCalls.length, 1));
  assert.equal(textbox.value, "/goal ship it", "the builtin has not completed");
  await user.keyboard("{Enter}");
  assert.deepEqual(builtinCalls, ["/goal ship it"], "repeated Enter must not execute the pending builtin again");
  await act(async () => { finish({ handled: true }); });
  await waitFor(() => assert.equal(textbox.value, ""));
  assert.equal(getDraft(KEY), null, "success clears the unchanged builtin draft");
});

test("a completed slash builtin must not erase an attachment added while its callback was pending", async (t) => {
  override(window.HTMLElement.prototype, "scrollIntoView", () => {});
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  t.after(async () => { await act(async () => { finish({ handled: true }); }); });
  const builtinCalls = [];
  const ref = React.createRef();
  const user = userEvent.setup();
  render(React.createElement(ChatInput, {
    ref,
    draftKey: KEY,
    isStreaming: false,
    onAbort() {},
    onSend: async () => ({ status: "accepted" }),
    onBuiltinCommand: (message) => {
      builtinCalls.push(message);
      return pending;
    },
  }));
  const textbox = screen.getByRole("textbox");
  await user.type(textbox, "/goal keep this draft");
  await user.keyboard("{Enter}");
  await waitFor(() => assert.deepEqual(builtinCalls, ["/goal keep this draft"]));
  await act(async () => {
    ref.current.addFiles([
      new File(["added while pending"], "pending.txt", { type: "text/plain" }),
    ]);
  });
  await waitFor(() => assert.equal(getDraft(KEY)?.files[0]?.name, "pending.txt"));
  const changedDraft = getDraft(KEY);
  assert.equal(changedDraft.files[0].content, "added while pending");
  await act(async () => { finish({ handled: true }); });
  assert.equal(textbox.value, "/goal keep this draft", "an attachment change preserves the composer text too");
  assert.deepEqual(getDraft(KEY), changedDraft, "builtin completion must not erase the newly attached file");
});

test("a rejected attachment prompt retains its files rather than becoming a shell command on retry", async () => {
  const file = { name: "notes.txt", mimeType: "text/plain", content: "echo attachment-content", size: 23 };
  setDraft(KEY, { value: "!!explain this", images: [], files: [file] });
  let attempts = 0;
  const submissions = [];
  render(React.createElement(ChatInput, {
    draftKey: KEY, isStreaming: false, onAbort() {},
    onSend: async (...args) => {
      submissions.push(args);
      return { status: ++attempts === 1 ? "rejected" : "accepted" };
    },
  }));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => assert.deepEqual(getDraft(KEY), { value: "!!explain this", images: [], files: [file], promptOnly: true }));
  assert.equal(document.querySelector(".chat-input-shell").hasAttribute("data-shell"), false);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => assert.equal(submissions.length, 2));
  assert.equal(submissions[1][0], "!!explain this\n\nAttached file: notes.txt\n```text\necho attachment-content\n```");
  assert.deepEqual(submissions[1][4], { promptOnly: true });
});

