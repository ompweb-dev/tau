import assert from "node:assert/strict";
import test from "node:test";

// Real POST /api/notifications/presence against the hub's in-memory presence.
const route = await import("../app/api/notifications/presence/route.ts");

const post = (body) => route.POST(new Request("http://localhost/api/notifications/presence", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));
const report = (patch) => ({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionIds: ["s1"], seq: 1, ...patch });
const stored = () => globalThis.__tauNotificationHub.presence.get("tab-0001");

test("presence keeps every chat on screen, at most 32, and refuses a malformed list", async () => {
  assert.equal((await post(report({ sessionIds: ["s1", "s2"], seq: 1 }))).status, 204);
  assert.deepEqual(stored().sessionIds, ["s1", "s2"]);

  const many = Array.from({ length: 40 }, (_, i) => `s${i}`);
  assert.equal((await post(report({ sessionIds: many, seq: 2 }))).status, 204);
  assert.deepEqual(stored().sessionIds, many.slice(0, 32), "a report naming more keeps the first 32");

  for (const sessionIds of [undefined, "s1", [""], [1], ["x".repeat(257)]]) {
    assert.equal((await post(report({ sessionIds, seq: 3 }))).status, 400, JSON.stringify(sessionIds)?.slice(0, 20));
  }
  assert.equal(stored().seq, 2, "a refused report changes nothing");
});
