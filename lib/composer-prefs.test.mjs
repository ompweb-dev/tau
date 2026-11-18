import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

async function loadSubject() {
  return import("./composer-prefs.ts");
}

function fakeWindow({ submitDuringRun }) {
  const entries = [];
  if (submitDuringRun !== undefined) entries.push(["omp-web:submit-during-run", submitDuringRun]);
  const store = new Map(entries);
  globalThis.window = {
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
  };
}

afterEach(() => {
  delete globalThis.window;
});

test("submitting during a run defaults to queue; only a stored choice overrides it", async () => {
  const { getSubmitDuringRunBehavior, setSubmitDuringRunBehavior } = await loadSubject();
  assert.equal(getSubmitDuringRunBehavior(), "queue");
  fakeWindow({});
  assert.equal(getSubmitDuringRunBehavior(), "queue");
  fakeWindow({ submitDuringRun: "steer" });
  assert.equal(getSubmitDuringRunBehavior(), "steer");
  setSubmitDuringRunBehavior("queue");
  assert.equal(getSubmitDuringRunBehavior(), "queue");
  fakeWindow({ submitDuringRun: "sometimes" });
  assert.equal(getSubmitDuringRunBehavior(), "queue");
});
