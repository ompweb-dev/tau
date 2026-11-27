import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";

const store = await import("./watch-store.ts");

const cursor = (over = {}) => ({ commentIds: [], reviewIds: [], threadCommentIds: [], reportedHeads: [], final: false, ...over });
const ITEM = "acme/widgets#7";
/** Watches without their generated registration identity. */
const listed = () => store.listWatches().map(({ createdAt, registrationId, ...watch }) => (assert.equal(typeof createdAt, "number"), assert.equal(typeof registrationId, "string"), watch));
const watchOf = (sessionId, itemKey) => store.listWatches().find((watch) => watch.sessionId === sessionId && watch.itemKey === itemKey);
const asPending = (pending) => ({
  entryId: pending.entryId,
  cursor: pending.cursor,
  final: pending.final,
  batches: pending.batches ?? [{ entryId: pending.entryId, message: pending.message }],
  batchIndex: pending.batchIndex ?? 0,
});
const claim = (sessionId, itemKey, pending, watch = watchOf(sessionId, itemKey), eventIds = []) =>
  store.claimPending(sessionId, "local", itemKey, watch.registrationId, watch.cursor, asPending(pending), eventIds) ? pending : null;
const commit = (sessionId, itemKey, pending, watch = watchOf(sessionId, itemKey)) => {
  const current = store.getPending(sessionId, "local", itemKey, watch.registrationId);
  if (!current) return false;
  for (let index = current.batchIndex; index < current.batches.length; index++) {
    if (!store.advancePendingBatch(sessionId, "local", itemKey, watch.registrationId, current.entryId, index)) return false;
  }
  return store.commitUpdate(sessionId, "local", itemKey, watch.registrationId, pending.entryId, pending.cursor, pending.final);
};

/** A fresh agent dir; `reopen()` drops the cached handle, as a restart would. */
function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "tau-watch-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const connections = new Set();
  const trackConnection = (database) => {
    connections.add(database);
    return database;
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  store.closeWatchStore();
  t.after(() => {
    if (connections.has(globalThis.__tauGithubWatchStore?.db)) globalThis.__tauGithubWatchStore = undefined;
    store.closeWatchStore();
    for (const connection of connections) connection.close(true);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, reopen: store.closeWatchStore, trackConnection };
}

test("the 21st watch of a session is refused", (t) => {
  isolated(t);
  for (let n = 1; n <= 20; n++) assert.equal(store.addWatch("s1", "local", `acme/widgets#${n}`, "pull_request", cursor()), "added");
  assert.equal(store.addWatch("s1", "local", "acme/widgets#21", "pull_request", cursor()), "limit");
  assert.equal(store.addWatch("s2", "local", "acme/widgets#21", "pull_request", cursor()), "added");
});

test("adding a watch twice keeps the stored cursor", (t) => {
  isolated(t);
  assert.equal(store.addWatch("s1", "local", ITEM, "issue", cursor({ commentIds: ["IC_1"] })), "added");
  assert.equal(store.addWatch("s1", "local", ITEM, "issue", cursor({ commentIds: ["IC_9"] })), "exists");
  assert.deepEqual(listed(), [{ sessionId: "s1", hostId: "local", itemKey: ITEM, kind: "issue", cursor: cursor({ commentIds: ["IC_1"] }) }]);
});

test("commitUpdate with final removes the watch", (t) => {
  isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const update = { entryId: "e1", message: "m1", cursor: cursor({ commentIds: ["IC_2"] }), final: false };
  assert.deepEqual(claim("s1", ITEM, update), update);
  assert.equal(commit("s1", ITEM, update), true);
  assert.deepEqual(store.listWatches()[0].cursor, cursor({ commentIds: ["IC_2"] }));
  const final = { entryId: "e2", message: "m2", cursor: cursor({ final: true }), final: true };
  assert.deepEqual(claim("s1", ITEM, final), final);
  assert.equal(commit("s1", ITEM, final), true);
  assert.deepEqual(store.listWatches(), []);
});
test("watches survive reopening the store", (t) => {
  const { reopen } = isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor({ reportedHeads: ["abc"] }));
  reopen();
  assert.deepEqual(listed(), [{ sessionId: "s1", hostId: "local", itemKey: ITEM, kind: "pull_request", cursor: cursor({ reportedHeads: ["abc"] }) }]);
});

test("claimPending then commitUpdate clears the pending batch", (t) => {
  isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const pending = { entryId: "e1", message: "GitHub update (tau): acme/widgets#7 https://x", cursor: cursor({ commentIds: ["IC_3"] }), final: false };
  assert.deepEqual(claim("s1", ITEM, pending), pending);
  assert.deepEqual(store.getPending("s1", "local", ITEM), asPending(pending));
  assert.equal(commit("s1", ITEM, pending), true);
  assert.equal(store.getPending("s1", "local", ITEM), null);
});

test("pending survives reopening the store", (t) => {
  const { reopen } = isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const origin = {
    v: 1, kind: "github", sentAt: "2026-11-15T12:41:00.000Z",
    github: { repo: "acme/widgets", number: 7, target: "pr", url: "https://x", events: [{ kind: "review" }] },
  };
  const pending = {
    entryId: "e2", message: "m", cursor: cursor({ final: true }), final: true,
    batches: [{ entryId: "e2", message: "m", origin }],
  };
  assert.deepEqual(claim("s1", ITEM, pending), pending);
  reopen();
  assert.deepEqual(store.getPending("s1", "local", ITEM), asPending(pending));
});

test("removeWatch carries pending rows with the watch", (t) => {
  isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const pending = { entryId: "e3", message: "m", cursor: cursor(), final: false };
  claim("s1", ITEM, pending);
  assert.equal(store.removeWatch("s1", "local", ITEM), true);
  assert.equal(store.getPending("s1", "local", ITEM), null);
  assert.equal(store.removeWatch("s1", "local", ITEM), false);
});

test("removeSessionWatches drops the session's watches, pending updates and read grants", (t) => {
  isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  store.addWatch("s2", "local", "acme/widgets#8", "issue", cursor());
  claim("s1", ITEM, { entryId: "e6", message: "m", cursor: cursor(), final: false });
  store.grantRead("s1", "local", "acme/widgets");
  store.grantRead("s2", "local", "acme/widgets");
  store.removeSessionWatches("s1", "local");
  assert.deepEqual(store.listWatches().map((w) => w.sessionId), ["s2"]);
  assert.equal(store.getPending("s1", "local", ITEM), null);
  assert.equal(store.hasReadGrant("s1", "local", "acme/widgets"), false);
  assert.equal(store.hasReadGrant("s2", "local", "acme/widgets"), true);
});

test("claimPending on a removed watch stores nothing", (t) => {
  isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const oldWatch = watchOf("s1", ITEM);
  const pending = { entryId: "e5", message: "m", cursor: cursor(), final: false };
  assert.deepEqual(claim("s1", ITEM, pending), pending);
  assert.equal(store.removeWatch("s1", "local", ITEM), true);
  assert.equal(store.claimPending("s1", "local", ITEM, oldWatch.registrationId, oldWatch.cursor, asPending(pending), []), null);
  assert.equal(store.getPending("s1", "local", ITEM), null);
});

test("separate connections cannot replace a pending batch from the same cursor", (t) => {
  const { dir, trackConnection } = isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const watch = watchOf("s1", ITEM);
  const primary = globalThis.__tauGithubWatchStore;
  trackConnection(primary.db);
  const secondary = trackConnection(new Database(join(dir, "tau", "github-watches.sqlite")));
  secondary.exec("PRAGMA busy_timeout = 5000");
  assert.notEqual(primary.db, secondary);

  const batchA = { entryId: "event-a", message: "A", cursor: cursor({ commentIds: ["A"] }), final: false };
  const batchAB = { entryId: "event-a-b", message: "A, B", cursor: cursor({ commentIds: ["A", "B"] }), final: false };
  assert.deepEqual(claim("s1", ITEM, batchA, watch, ["A"]), batchA);
  globalThis.__tauGithubWatchStore = { path: primary.path, db: secondary };
  assert.equal(store.claimPending("s1", "local", ITEM, watch.registrationId, watch.cursor, asPending(batchAB), ["A", "B"]), null);
  assert.deepEqual(store.getPending("s1", "local", ITEM, watch.registrationId), asPending(batchA));

  globalThis.__tauGithubWatchStore = primary;
  assert.equal(commit("s1", ITEM, batchA, watch), true);
  assert.equal(store.claimPending("s1", "local", ITEM, watch.registrationId, watch.cursor, asPending(batchAB), ["A", "B"]), null);
  assert.equal(store.getPending("s1", "local", ITEM), null);
  assert.deepEqual(store.listWatches()[0].cursor, batchA.cursor);
});

test("stale final and non-final commits cannot mutate a re-registered watch", (t) => {
  isolated(t);
  for (const final of [false, true]) {
    const sessionId = `s-${final}`;
    const baseline = cursor();
    store.addWatch(sessionId, "local", ITEM, "pull_request", baseline);
    const oldWatch = watchOf(sessionId, ITEM);
    const oldPending = { entryId: `old-${final}`, message: "old", cursor: cursor({ commentIds: ["OLD"], final }), final };
    assert.deepEqual(claim(sessionId, ITEM, oldPending, oldWatch), oldPending);
    assert.equal(store.removeWatch(sessionId, "local", ITEM), true);
    assert.equal(store.addWatch(sessionId, "local", ITEM, "pull_request", baseline), "added");
    const newWatch = watchOf(sessionId, ITEM);
    assert.notEqual(newWatch.registrationId, oldWatch.registrationId);
    const newPending = { entryId: `new-${final}`, message: "new", cursor: cursor({ commentIds: ["NEW"] }), final: false };
    assert.deepEqual(claim(sessionId, ITEM, newPending, newWatch), newPending);

    assert.equal(store.commitUpdate(sessionId, "local", ITEM, oldWatch.registrationId, oldPending.entryId, oldPending.cursor, final), false);
    assert.deepEqual(watchOf(sessionId, ITEM).cursor, baseline);
    assert.deepEqual(store.getPending(sessionId, "local", ITEM, newWatch.registrationId), asPending(newPending));
  }
});

test("cursor-only advances require the current registration, base cursor, and no pending batch", (t) => {
  isolated(t);
  const baseline = cursor();
  store.addWatch("s1", "local", ITEM, "pull_request", baseline);
  const oldWatch = watchOf("s1", ITEM);
  store.removeWatch("s1", "local", ITEM);
  const newBaseline = cursor({ commentIds: ["NEW"] });
  store.addWatch("s1", "local", ITEM, "pull_request", newBaseline);
  const current = watchOf("s1", ITEM);
  const staleCursor = cursor({ commentIds: ["STALE"] });
  assert.equal(store.advanceCursor("s1", "local", ITEM, oldWatch.registrationId, oldWatch.cursor, staleCursor), false);
  assert.deepEqual(watchOf("s1", ITEM).cursor, newBaseline);
  const advanced = cursor({ commentIds: ["NEW", "NEXT"] });
  assert.equal(store.advanceCursor("s1", "local", ITEM, current.registrationId, current.cursor, advanced), true);
  assert.deepEqual(watchOf("s1", ITEM).cursor, advanced);
  const pending = { entryId: "pending", message: "m", cursor: cursor({ commentIds: ["NEW", "NEXT", "PENDING"] }), final: false };
  assert.deepEqual(claim("s1", ITEM, pending), pending);
  assert.equal(store.advanceCursor("s1", "local", ITEM, current.registrationId, advanced, pending.cursor), false);
});

test("posted ids are kept per item", (t) => {
  isolated(t);
  store.recordPosted(ITEM, "IC_10");
  store.recordPosted(ITEM, "IC_10");
  store.recordPosted("acme/widgets#8", "IC_11");
  assert.deepEqual([...store.postedIds(ITEM)], ["IC_10"]);
});

test("itemKeyOf and repoKeyOf lower-case owner and repo", () => {
  assert.equal(store.itemKeyOf({ owner: "Acme", repo: "Widgets", number: 7 }), "acme/widgets#7");
  assert.equal(store.repoKeyOf({ owner: "Acme", repo: "Widgets", number: 7 }), "acme/widgets");
});

test("a shared post lease prevents self-post claims across connections", async (t) => {
  const { dir, trackConnection } = isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const watch = watchOf("s1", ITEM);
  const primary = globalThis.__tauGithubWatchStore;
  trackConnection(primary.db);
  const secondary = trackConnection(new Database(join(dir, "tau", "github-watches.sqlite")));
  secondary.exec("PRAGMA busy_timeout = 5000");

  let startPost;
  const started = new Promise((resolve) => { startPost = resolve; });
  let finishPost;
  const blocked = new Promise((resolve) => { finishPost = resolve; });
  const post = store.whilePosting(ITEM, async () => {
    startPost();
    await blocked;
    store.recordPosted(ITEM, "IC_self");
  });
  await started;

  const pending = { entryId: "self-post", message: "own post", cursor: cursor({ commentIds: ["IC_self"] }), final: false };
  globalThis.__tauGithubWatchStore = { path: primary.path, db: secondary };
  assert.equal(store.isPosting(ITEM), true);
  assert.equal(store.claimPending("s1", "local", ITEM, watch.registrationId, watch.cursor, asPending(pending), ["IC_self"]), null);

  globalThis.__tauGithubWatchStore = primary;
  finishPost();
  await post;
  globalThis.__tauGithubWatchStore = { path: primary.path, db: secondary };
  assert.equal(store.isPosting(ITEM), false);
  assert.equal(store.claimPending("s1", "local", ITEM, watch.registrationId, watch.cursor, asPending(pending), ["IC_self"]), null);
  assert.deepEqual([...store.postedIds(ITEM)], ["IC_self"]);
  assert.equal(store.getPending("s1", "local", ITEM), null);
  globalThis.__tauGithubWatchStore = primary;
  await assert.rejects(store.whilePosting(ITEM, async () => { throw new Error("uncertain"); }), /uncertain/);
  assert.equal(store.isPosting(ITEM), true);
  globalThis.__tauGithubWatchStore = { path: primary.path, db: secondary };
  secondary.prepare("UPDATE active_posts SET lease_until = ? WHERE item_key = ?").run(Date.now() - 1, ITEM);
  assert.equal(store.isPosting(ITEM), false);
});

test("batch progress survives restart and only the complete update commits its cursor", (t) => {
  const { reopen } = isolated(t);
  const baseline = cursor();
  store.addWatch("s1", "local", ITEM, "pull_request", baseline);
  const watch = watchOf("s1", ITEM);
  const pending = {
    entryId: "whole-update",
    cursor: cursor({ commentIds: ["IC_1", "IC_2"] }),
    final: true,
    batches: [
      { entryId: "chunk-1", message: "first chunk" },
      { entryId: "chunk-2", message: "second chunk" },
    ],
    batchIndex: 0,
  };
  assert.deepEqual(store.claimPending("s1", "local", ITEM, watch.registrationId, watch.cursor, pending, ["IC_1", "IC_2"]), pending);
  const acceptedBeforeCrash = pending.batches[0].entryId;
  const outboxAccepted = new Set([acceptedBeforeCrash]);
  reopen();
  const replay = store.getPending("s1", "local", ITEM, watch.registrationId);
  assert.equal(replay.batchIndex, 0);
  assert.equal(replay.batches[0].entryId, acceptedBeforeCrash);
  assert.equal(outboxAccepted.has(replay.batches[replay.batchIndex].entryId), true);
  assert.equal(store.advancePendingBatch("s1", "local", ITEM, watch.registrationId, pending.entryId, 1), false);
  assert.equal(store.advancePendingBatch("s1", "local", ITEM, watch.registrationId, pending.entryId, 0), true);
  assert.equal(store.commitUpdate("s1", "local", ITEM, watch.registrationId, pending.entryId, pending.cursor, true), false);
  assert.equal(store.advancePendingBatch("s1", "local", ITEM, watch.registrationId, pending.entryId, 1), true);
  assert.equal(store.getPending("s1", "local", ITEM, watch.registrationId).batchIndex, 2);
  assert.equal(store.commitUpdate("s1", "local", ITEM, watch.registrationId, pending.entryId, pending.cursor, true), true);
  assert.deepEqual(store.listWatches(), []);
});

test("a store from before host keys is dropped, not migrated", (t) => {
  const { dir } = isolated(t);
  const storeDir = join(dir, "tau");
  mkdirSync(storeDir, { recursive: true });
  const legacy = new Database(join(storeDir, "github-watches.sqlite"));
  legacy.exec(`
    CREATE TABLE watches (session_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, cursor_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, item_key));
    CREATE TABLE pending (session_id TEXT NOT NULL, item_key TEXT NOT NULL, entry_id TEXT NOT NULL, message TEXT NOT NULL, cursor_json TEXT NOT NULL, final INTEGER NOT NULL, PRIMARY KEY (session_id, item_key));
  `);
  legacy.prepare("INSERT INTO watches VALUES (?, ?, ?, ?, ?)").run("s1", ITEM, "pull_request", JSON.stringify(cursor()), 1);
  legacy.close(true);

  assert.deepEqual(store.listWatches(), []);
  assert.equal(store.addWatch("s1", "remote", ITEM, "pull_request", cursor()), "added");
});

test("the same session id on two hosts keeps its own watches, pending updates and read grants", (t) => {
  isolated(t);
  assert.equal(store.addWatch("s1", "local", ITEM, "pull_request", cursor()), "added");
  assert.equal(store.addWatch("s1", "remote", ITEM, "pull_request", cursor()), "added", "another host's copy is not the same watch");
  for (let n = 1; n < 20; n++) store.addWatch("s1", "local", `acme/widgets#${n + 100}`, "pull_request", cursor());
  assert.equal(store.addWatch("s1", "local", "acme/widgets#999", "pull_request", cursor()), "limit");
  assert.equal(store.addWatch("s1", "remote", "acme/widgets#999", "pull_request", cursor()), "added", "the limit counts one host's copy");
  const remote = store.listWatches().find((watch) => watch.hostId === "remote" && watch.itemKey === ITEM);
  const update = { entryId: "e-remote", cursor: cursor({ reviewIds: ["PRR_1"] }), final: false, batches: [{ entryId: "e-remote", message: "m" }], batchIndex: 0 };
  assert.ok(store.claimPending("s1", "remote", ITEM, remote.registrationId, remote.cursor, update, []));
  assert.equal(store.getPending("s1", "local", ITEM), null, "a claim on one copy is not the other's");
  store.grantRead("s1", "remote", "acme/widgets");
  assert.equal(store.hasReadGrant("s1", "local", "acme/widgets"), false);

  store.removeSessionWatches("s1", "remote");
  assert.equal(store.listWatches().filter((watch) => watch.hostId === "remote").length, 0);
  assert.equal(store.listWatches().filter((watch) => watch.hostId === "local").length, 20, "removing one copy leaves the other's watches");
  assert.equal(store.hasReadGrant("s1", "remote", "acme/widgets"), false);
});

test("claims reject review snapshots whose REST alias is already posted", (t) => {
  isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const watch = watchOf("s1", ITEM);
  store.recordPosted(ITEM, "review:123");
  const pending = {
    entryId: "review-update",
    cursor: cursor({ reviewIds: ["PRR_node"] }),
    final: false,
    batches: [{ entryId: "review-batch", message: "review" }],
    batchIndex: 0,
  };
  assert.equal(store.claimPending("s1", "local", ITEM, watch.registrationId, watch.cursor, pending, ["PRR_node", "review:123"]), null);
  assert.equal(store.getPending("s1", "local", ITEM), null);
});

test("review alias posts fence claims that raced the snapshot diff", (t) => {
  isolated(t);
  store.addWatch("s1", "local", ITEM, "pull_request", cursor());
  const watch = watchOf("s1", ITEM);
  store.recordPosted(ITEM, "review:123");
  const pending = {
    entryId: "review-update",
    cursor: cursor({ reviewIds: ["PRR_node"] }),
    final: false,
    batches: [{ entryId: "review-batch", message: "review" }],
    batchIndex: 0,
  };
  assert.equal(store.claimPending("s1", "local", ITEM, watch.registrationId, watch.cursor, pending, ["PRR_node", "review:123"]), null);
  assert.equal(store.getPending("s1", "local", ITEM), null);
});

test("a second SQLite connection unwatch invalidates an in-flight intent", (t) => {
  const { dir, trackConnection } = isolated(t);
  const token = store.beginWatchIntent("s1", "local", ITEM);
  const primary = globalThis.__tauGithubWatchStore;
  trackConnection(primary.db);
  const secondary = trackConnection(new Database(join(dir, "tau", "github-watches.sqlite")));
  secondary.exec("PRAGMA busy_timeout = 5000");
  globalThis.__tauGithubWatchStore = { path: primary.path, db: secondary };
  assert.equal(store.removeWatch("s1", "local", ITEM), false);
  globalThis.__tauGithubWatchStore = primary;

  assert.equal(store.registerWatchIntent(token, "s1", "local", ITEM, "pull_request", cursor()), "cancelled");
  assert.deepEqual(store.listWatches(), []);
});

test("concurrent watch intents preserve the first accepted baseline", (t) => {
  isolated(t);
  const oldIntent = store.beginWatchIntent("s1", "local", ITEM);
  const newIntent = store.beginWatchIntent("s1", "local", ITEM);
  const newerCursor = cursor({ reviewIds: ["PRR_newer"] });

  assert.equal(store.registerWatchIntent(newIntent, "s1", "local", ITEM, "pull_request", newerCursor), "added");
  assert.equal(store.registerWatchIntent(oldIntent, "s1", "local", ITEM, "pull_request", cursor({ reviewIds: ["PRR_older"] })), "exists");
  assert.deepEqual(store.listWatches()[0].cursor, newerCursor);
});

test("session deletion cancels provisional watch intents", (t) => {
  isolated(t);
  const token = store.beginWatchIntent("s1", "local", ITEM);
  store.removeSessionWatches("s1", "local");

  assert.equal(store.registerWatchIntent(token, "s1", "local", ITEM, "pull_request", cursor()), "cancelled");
  assert.deepEqual(store.listWatches(), []);
});

