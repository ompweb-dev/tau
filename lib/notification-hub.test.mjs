import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import test from "node:test";

const hub = await import("./notification-hub.ts");
const { DEFAULT_NOTIFICATION_PREFS, buildNotificationDialog } = await import("./notification-events.ts");
const store = await import("./notification-store.ts");
const webpush = (await import("web-push")).default;

const event = { type: "completed", sessionId: "s1", sessionName: "Session" };
const prefs = (patch = {}) => ({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true, ...patch });
const tab = (clientId, deviceId, patch = {}) => ({ clientId, deviceId, visible: false, sessionId: null, lastSeen: 0, ...patch });
const device = (deviceId, patch = {}) => ({ deviceId, prefs: prefs(), updatedAt: 0, ...patch });
const subscription = { endpoint: "https://push.example/abc", keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) } };
const all = (...ids) => new Set(ids);

test("nothing is sent anywhere while a visible tab shows the session, even while its stream reconnects", () => {
  const presence = [tab("viewer", "desk", { visible: true, sessionId: "s1" }), tab("phone-tab", "phone")];
  const devices = [device("desk"), device("phone", { prefs: prefs({ whenActive: "system" }), subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all("phone-tab"), devices), []);
});

test("active in another session: toast on the active tab only, toast-mode devices elsewhere stay quiet", () => {
  const presence = [tab("desk-active", "desk", { visible: true, sessionId: "other" }), tab("desk-hidden", "desk"), tab("laptop-tab", "laptop")];
  const devices = [device("desk"), device("laptop")];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-active", "desk-hidden", "laptop-tab"), devices), [{ kind: "toast", clientId: "desk-active" }]);
});

test("a visible tab that cannot receive toasts (stream closed) does not silence other devices", () => {
  const presence = [tab("settings-open", "desk", { visible: true })];
  const devices = [device("desk"), device("phone", { subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all(), devices), [{ kind: "push", deviceId: "phone" }]);
});

test("'always send a system notification' devices still get one while the user is active elsewhere", () => {
  const presence = [tab("desk-active", "desk", { visible: true, sessionId: "other" })];
  const devices = [device("desk", { prefs: prefs({ whenActive: "system" }) }), device("phone", { prefs: prefs({ whenActive: "system" }), subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-active"), devices), [
    { kind: "os", clientId: "desk-active" },
    { kind: "push", deviceId: "phone" },
  ]);
});

test("nobody active: push to subscribed devices, in-page to reachable tabs of unsubscribed ones", () => {
  const presence = [tab("desk-tab", "desk"), tab("phone-tab", "phone"), tab("beacon-only", "laptop")];
  const devices = [device("desk"), device("phone", { subscription }), device("laptop")];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-tab", "phone-tab"), devices), [
    { kind: "os", clientId: "desk-tab" },
    { kind: "push", deviceId: "phone" },
  ]);
});

test("disabled devices and disabled types get nothing", () => {
  const presence = [tab("tab", "desk")];
  assert.deepEqual(hub.routeNotification(event, presence, all("tab"), [device("desk", { prefs: prefs({ enabled: false }) })]), []);
  assert.deepEqual(hub.routeNotification(event, presence, all("tab"), [device("desk", { prefs: prefs({ types: { ...DEFAULT_NOTIFICATION_PREFS.types, completed: false } }) })]), []);
});

test("push subscriptions must use an HTTPS endpoint and real key sizes", () => {
  assert.equal(store.parsePushSubscription({ ...subscription, endpoint: "http://127.0.0.1:8080/x" }), null);
  assert.equal(store.parsePushSubscription({ ...subscription, keys: { p256dh: "not-a-real-key", auth: "x" } }), null);
  assert.deepEqual(store.parsePushSubscription(subscription), subscription);
});

const reopenStore = store.closeNotificationStore;

function isolatedStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "tau-notify-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousSend = webpush.sendNotification;
  const previousHub = globalThis.__tauNotificationHub;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__tauNotificationHub = undefined;
  reopenStore();
  t.after(() => {
    webpush.sendNotification = previousSend;
    globalThis.__tauNotificationHub = previousHub;
    reopenStore();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("another tau instance sharing the agent dir sees the same keys and devices", (t) => {
  isolatedStore(t);
  store.saveDevice("phone-device", prefs({ locale: "ja" }), subscription);
  const publicKey = hub.getVapidPublicKey();

  // The other instance has its own handle on the shared store.
  reopenStore();
  store.saveDevice("laptop-device", prefs());
  reopenStore();

  assert.equal(hub.getVapidPublicKey(), publicKey);
  assert.equal(store.getDevice("laptop-device").prefs.enabled, true);
  store.saveDevice("phone-device", prefs({ locale: "en" }));
  assert.ok(store.getDevice("laptop-device"), "saving one device keeps the other instance's devices");
  assert.deepEqual(store.getDevice("phone-device").subscription, subscription);
});

test("a notification some device wants is recorded even when no tab or push receives it", (t) => {
  isolatedStore(t);
  store.saveDevice("desk-0001", prefs());
  hub.publishNotification(event);
  assert.deepEqual(store.listHistory().map((entry) => [entry.id, entry.read, entry.event.sessionName]), [["s1:completed", false, "Session"]]);
});

test("a notification no device has turned on is not recorded", (t) => {
  isolatedStore(t);
  hub.publishNotification(event);
  store.saveDevice("desk-0001", prefs({ enabled: false }));
  store.saveDevice("phone-0001", prefs({ types: { ...DEFAULT_NOTIFICATION_PREFS.types, completed: false } }));
  hub.publishNotification(event);
  assert.deepEqual(store.listHistory(), []);
});

test("a notification for the session a visible tab shows is recorded as already read", (t) => {
  isolatedStore(t);
  store.saveDevice("desk-0001", prefs());
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "s1", seq: 1 });
  hub.publishNotification(event);
  assert.deepEqual(store.listHistory().map((entry) => [entry.id, entry.read]), [["s1:completed", true]]);
});

test("an unusable store never breaks publishing", (t) => {
  const dir = isolatedStore(t);
  // The data directory's place is taken by a file: the store cannot open.
  writeFileSync(join(dir, "tau"), "");
  t.mock.method(console, "warn", () => {});
  assert.doesNotThrow(() => hub.publishNotification(event));
});

test("test notifications are never recorded", (t) => {
  isolatedStore(t);
  hub.publishNotification({ type: "test", sessionId: "", sessionName: "tau" });
  assert.deepEqual(store.listHistory(), []);
});

test("a failed history write does not stop delivery", (t) => {
  const dir = isolatedStore(t);
  store.saveDevice("desk-0001", prefs({ whenActive: "system" }));
  const raw = new Database(join(dir, "tau", "notifications.db"));
  raw.exec("DROP TABLE history");
  raw.close();
  const received = [];
  hub.attachNotificationClient("tab-0001", (message) => received.push(message.kind));
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: false, sessionId: null, seq: 1 });
  t.mock.method(console, "warn", () => {});
  hub.publishNotification(event);
  assert.deepEqual(received, ["os"]);
});

test("a tab stays reachable when a stale stream of the same tab attaches late and then closes", (t) => {
  isolatedStore(t);
  store.saveDevice("desk-0001", prefs());
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: false, sessionId: null, seq: 1 });

  // React strict mode / reconnects: the cancelled request reaches the server
  // after the live one, then its abort fires.
  const received = [];
  const detachLive = hub.attachNotificationClient("tab-0001", () => received.push("live"));
  const detachStale = hub.attachNotificationClient("tab-0001", () => received.push("stale"));
  detachStale();
  hub.publishNotification(event);
  assert.deepEqual(received, ["live"]);

  detachLive();
  hub.publishNotification(event);
  assert.deepEqual(received, ["live"]);
});

test("a presence report that arrives after a newer one from the same tab is ignored", (t) => {
  isolatedStore(t);
  store.saveDevice("desk-0001", prefs({ whenActive: "system" }));
  const received = [];
  hub.attachNotificationClient("tab-0001", () => received.push("tab"));
  // The tab moved from s1 to s2, but the s1 report lands last.
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "s2", seq: 2 });
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "s1", seq: 1 });
  hub.publishNotification(event);
  assert.deepEqual(received, ["tab"], "s1 is no longer on screen, so its notification goes out");
});

test("pushes are written in the device's language with urgency by type", async (t) => {
  isolatedStore(t);
  const sent = [];
  webpush.sendNotification = async (_subscription, payload, options) => {
    sent.push({ payload: JSON.parse(payload), urgency: options.urgency, ttl: options.TTL });
  };
  store.saveDevice("phone-device", prefs({ locale: "ja" }), subscription);
  hub.publishNotification(event);
  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", detail: "Ship it?" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent.map(({ payload, urgency, ttl }) => [payload.body, payload.url, payload.type, urgency, ttl]), [
    ["タスクが完了しました。", "/?session=s1", "completed", "normal", 3600],
    ["回答を待っています: Ship it?", "/?session=s2", "input", "high", 3600],
  ]);
});

test("an answerable dialog never pushes a payload over the 4 KB cap", async (t) => {
  isolatedStore(t);
  const sent = [];
  webpush.sendNotification = async (_subscription, payload) => {
    sent.push({ size: Buffer.byteLength(payload), payload: JSON.parse(payload) });
  };
  store.saveDevice("phone-0001", prefs(), subscription);

  // The largest confirm the dialog budget admits (title 160 + message 480).
  const dialog = buildNotificationDialog({
    id: "req-push",
    method: "confirm",
    title: "t".repeat(160),
    message: "m".repeat(480),
  });
  assert.ok(dialog, "a dialog at every text cap is still representable");
  hub.publishNotification({
    type: "input",
    sessionId: "s2",
    sessionName: "Deploy",
    // The rendered body clips this; the raw detail must not widen the payload.
    detail: "d".repeat(5_000),
    requestId: "req-push",
    dialog,
  });

  // An ask with five full-length questions, on a session with a long CJK name:
  // the body repeats the questions verbatim beside the dialog.
  const questions = Array.from({ length: 5 }, (_, index) => ({ id: `q${index}`, question: `${index}:${"q".repeat(238)}` }));
  const ask = buildNotificationDialog({ id: "req-ask", method: "ask", questions });
  assert.ok(ask, "five capped questions still fit the dialog budget");
  hub.publishNotification({
    type: "input",
    sessionId: "s3",
    sessionName: "会話".repeat(30),
    detail: "d".repeat(5_000),
    requestId: "req-ask",
    dialog: ask,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 2);
  for (const push of sent) assert.ok(push.size <= 3993, `push payload is ${push.size} bytes`);
  assert.deepEqual(sent[0].payload.dialog, dialog);
  for (const question of questions) assert.ok(sent[1].payload.body.includes(question.question), question.id);
  assert.ok(!sent[1].payload.body.includes("…"));
});

test("a multibyte dialog that would push the payload past 3993 bytes goes out without its dialog", async (t) => {
  isolatedStore(t);
  const sent = [];
  webpush.sendNotification = async (_subscription, payload) => {
    sent.push({ size: Buffer.byteLength(payload), payload: JSON.parse(payload) });
  };
  store.saveDevice("phone-0002", prefs(), subscription);
  // The admission budget counts the dialog alone; the body repeats its text beside the title. A dialog
  // past the remaining room (built directly here) must not take the push over the limit.
  const dialog = { requestId: "req-wide", method: "confirm", title: "問".repeat(160), message: "答".repeat(480) };
  hub.publishNotification({ type: "input", sessionId: "s4", sessionName: "会話".repeat(50), requestId: "req-wide", dialog });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].size <= 3993, `push payload is ${sent[0].size} bytes`);
  assert.equal(sent[0].payload.dialog, undefined);
  assert.equal(sent[0].payload.requestId, "req-wide", "the retraction still matches it");
});

test("a dialog settled for good is not announced again when its request is replayed", async (t) => {
  isolatedStore(t);
  const sent = [];
  webpush.sendNotification = async (_subscription, payload) => { sent.push(JSON.parse(payload)); };
  store.saveDevice("phone-0003", prefs(), subscription);
  const event = { type: "input", sessionId: "s5", sessionName: "Deploy", requestId: "req-done", detail: "Ship it?" };
  hub.publishNotificationDismiss("s5", "req-done");
  hub.publishNotification(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, []);
  assert.deepEqual(store.listHistory().filter((entry) => entry.event.sessionId === "s5"), [], "no unread entry for a settled question");
});

for (const status of [404, 410]) {
  test(`a push service ${status} removes the subscription but keeps the device prefs`, async (t) => {
    isolatedStore(t);
    webpush.sendNotification = async () => {
      throw new webpush.WebPushError("Gone", status, {}, "", subscription.endpoint);
    };
    store.saveDevice("phone-device", prefs(), subscription);
    assert.deepEqual(await hub.sendTestPush("phone-device"), { ok: false, error: `push service answered ${status}` });

    const stored = store.getDevice("phone-device");
    assert.equal(stored.subscription, undefined);
    assert.equal(stored.prefs.enabled, true);
  });
}

const offline = () => new AggregateError([
  Object.assign(new Error("connect ENETUNREACH 2001:db8::1:443"), { code: "ENETUNREACH" }),
  Object.assign(new Error("connect ETIMEDOUT 192.0.2.1:443"), { code: "ETIMEDOUT" }),
]);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a push that never reaches the push service is retried with backoff and logs the cause", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    if (attempts < 3) throw offline();
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification(event);
  await flush();
  assert.equal(attempts, 1);
  assert.match(warn.mock.calls[0].arguments.join(" "), /retrying in 2s: connect ENETUNREACH 2001:db8::1:443; connect ETIMEDOUT 192\.0\.2\.1:443/);

  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[0]);
  await flush();
  assert.equal(attempts, 2);
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[1]);
  await flush();
  assert.equal(attempts, 3, "delivered on the third attempt");
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[2]);
  await flush();
  assert.equal(attempts, 3, "nothing is sent after a success");
});

test("a busy push service is retried until the retries run out", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw new webpush.WebPushError("Busy", attempts % 2 ? 503 : 429, {}, "", subscription.endpoint);
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification(event);
  for (const delay of hub.PUSH_RETRY_DELAYS_MS) {
    await flush();
    t.mock.timers.tick(delay);
  }
  await flush();
  assert.equal(attempts, hub.PUSH_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(warn.mock.calls.at(-1).arguments, ["[notifications] push failed:", "push service answered 429"]);
});

test("a push the push service refused is not retried", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw new webpush.WebPushError("Forbidden", 403, {}, "", subscription.endpoint);
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification(event);
  await flush();
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0));
  await flush();
  assert.equal(attempts, 1);
});

test("a retry is dropped once the device turned notifications off", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw offline();
  };
  store.saveDevice("phone-device", prefs(), subscription);
  hub.publishNotification(event);
  await flush();
  store.saveDevice("phone-device", prefs({ enabled: false }));
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[0]);
  await flush();
  assert.equal(attempts, 1);
});

test("a settled dialog is retracted on every reachable stream and its history entry becomes read", (t) => {
  isolatedStore(t);
  store.saveDevice("phone-0001", prefs());
  const received = [];
  hub.attachNotificationClient("phone-tab", (message) => received.push(message));
  hub.reportPresence({ clientId: "phone-tab", deviceId: "phone-0001", visible: false, sessionId: null, seq: 1 });
  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", requestId: "req-1", detail: "Ship it?" });
  assert.deepEqual(received.map((message) => message.kind), ["os"]);
  assert.deepEqual(store.listHistory().map((entry) => [entry.id, entry.read]), [["s2:input", false]]);

  hub.publishNotificationDismiss("s2", "req-1");
  assert.deepEqual(received.at(-1), { kind: "dismiss", tag: "s2:input", sessionId: "s2", requestId: "req-1" });
  assert.deepEqual(store.listHistory().map((entry) => [entry.id, entry.read]), [["s2:input", true]]);
});

test("a retraction pushes nothing at all: a push that displays nothing is a silent push", async (t) => {
  isolatedStore(t);
  const sent = [];
  webpush.sendNotification = async (_subscription, payload) => {
    sent.push(JSON.parse(payload));
  };
  // Both a subscribed phone and an iPhone: neither may get a dismiss push.
  // Chromium and Firefox answer a push that shows nothing with a generic card
  // and mute the origin; iOS revokes the permission outright.
  store.saveDevice("phone-0001", prefs(), subscription);
  store.saveDevice("iphone-0001", prefs(), { ...subscription, endpoint: "https://web.push.apple.com/xyz" });
  hub.publishNotificationDismiss("s2", "req-1");
  await flush();
  assert.deepEqual(sent, [], "no device is pushed a retraction");
});

test("the retraction reads only the entry of its own request, not a newer dialog of the same tag", (t) => {
  isolatedStore(t);
  store.saveDevice("phone-0001", prefs());
  // Request A's entry is replaced by request B's, which is still pending.
  store.recordHistory({ type: "input", sessionId: "s2", sessionName: "Deploy", requestId: "req-B", detail: "Or now?" });
  hub.publishNotificationDismiss("s2", "req-A");
  assert.deepEqual(store.listHistory().map((entry) => [entry.event.requestId, entry.read]), [["req-B", false]], "a stale retraction leaves the pending entry unread");
  hub.publishNotificationDismiss("s2", "req-B");
  assert.deepEqual(store.listHistory().map((entry) => [entry.event.requestId, entry.read]), [["req-B", true]]);
});

test("a forgotten dialog is retracted now, and a replay of the same request is announced and pushed again", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const pushes = [];
  webpush.sendNotification = async (_subscription, payload) => {
    pushes.push(JSON.parse(payload).requestId);
    throw offline();
  };
  // One device takes pushes, another has only a reachable tab.
  store.saveDevice("phone-0001", prefs(), subscription);
  store.saveDevice("desk-0001", prefs());
  const frames = [];
  hub.attachNotificationClient("tab-0001", (message) => frames.push(message));
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: false, sessionId: null, seq: 1 });

  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", requestId: "req-1" });
  await flush();
  assert.deepEqual(pushes, ["req-1"]);
  assert.equal(frames.at(-1).kind, "os", "the tab shows the question");

  // A resync dropped the dialog: it is retracted now, so no tab keeps offering it.
  hub.publishNotificationForgotten("s2", "req-1");
  assert.deepEqual(frames.at(-1), { kind: "dismiss", tag: "s2:input", sessionId: "s2", requestId: "req-1" });

  // The host replays the same request id: the question is pending again, so its
  // notification goes out and its push is attempted, not suppressed by the
  // retraction the resync just recorded.
  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", requestId: "req-1" });
  await flush();
  assert.equal(frames.at(-1).kind, "os", "the replayed question is delivered again");
  assert.deepEqual(pushes, ["req-1", "req-1"], "the push of the replayed question is not suppressed");
});

test("a forgotten dialog stays retracted while no replay restores it", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw offline();
  };
  store.saveDevice("phone-0001", prefs(), subscription);
  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", requestId: "req-1" });
  await flush();
  assert.equal(attempts, 1);
  hub.publishNotificationForgotten("s2", "req-1");
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[0]);
  await flush();
  assert.equal(attempts, 1, "the sleeping retry woke up after the resync and sent nothing");
});

test("a forgotten retraction never lifts a permanent settlement of the same request", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw offline();
  };
  store.saveDevice("phone-0001", prefs(), subscription);
  // Answered, then a resync forgets a dialog of the same session.
  hub.publishNotificationDismiss("s2", "req-1");
  hub.publishNotificationForgotten("s2", "req-1");
  // A replay of the answered request must not reopen its notification.
  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", requestId: "req-1" });
  await flush();
  assert.equal(attempts, 0, "an answered dialog is never pushed again");
});

test("a retraction never pushes, whatever the device's preferences are", async (t) => {
  isolatedStore(t);
  const sent = [];
  webpush.sendNotification = async (_subscription, payload) => {
    sent.push(JSON.parse(payload));
  };
  // Each device needs its own endpoint: saving one moves it off any other device.
  store.saveDevice("phone-0001", prefs({ enabled: false }), subscription);
  store.saveDevice("phone-0002", prefs({ types: { ...DEFAULT_NOTIFICATION_PREFS.types, input: false } }), { ...subscription, endpoint: "https://push.example/def" });
  hub.publishNotificationDismiss("s2", "req-1");
  await flush();
  assert.deepEqual(sent, [], "a retraction is not an alert and is never pushed, gated or not");
});

test("a push retry after the dialog settled delivers nothing", async (t) => {
  isolatedStore(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw offline();
  };
  store.saveDevice("phone-0001", prefs(), subscription);
  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", requestId: "req-1" });
  await flush();
  assert.equal(attempts, 1);
  hub.publishNotificationDismiss("s2", "req-1");
  t.mock.timers.tick(hub.PUSH_RETRY_DELAYS_MS[0]);
  await flush();
  assert.equal(attempts, 1, "the sleeping retry woke up after the answer and sent nothing");
});

test("the test button gets one attempt and the network failure's cause", async (t) => {
  isolatedStore(t);
  t.mock.method(console, "warn", () => {});
  let attempts = 0;
  webpush.sendNotification = async () => {
    attempts += 1;
    throw offline();
  };
  store.saveDevice("phone-device", prefs(), subscription);
  assert.deepEqual(await hub.sendTestPush("phone-device"), {
    ok: false,
    error: "connect ENETUNREACH 2001:db8::1:443; connect ETIMEDOUT 192.0.2.1:443",
  });
  assert.equal(attempts, 1);
});
