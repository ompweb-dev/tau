import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, render } = await import("@testing-library/react/pure.js");

const { PiRuntimeVersion } = await import("./ChatWindow.tsx");
afterEach(cleanup);

test("version survives refresh errors but confirmed unavailability invalidates it", async (t) => {
  const pending = [];
  t.mock.method(globalThis, "fetch", () => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  }));
  const mount = () => render(React.createElement(PiRuntimeVersion));
  const respond = async (version, status = 200) => {
    await act(async () => {
      pending.shift().resolve(new Response(JSON.stringify({ version }), { status }));
    });
  };

  let view = mount();
  assert.equal(view.container.textContent, "pi Loading…");
  await respond(null, 500);
  assert.equal(view.container.textContent, "pi not found");
  view.unmount();

  view = mount();
  await respond("1.5.2");
  assert.equal(view.container.textContent, "pi v1.5.2");
  view.unmount();

  view = mount();
  assert.equal(view.container.textContent, "pi v1.5.2");
  await respond(null, 500);
  assert.equal(view.container.textContent, "pi v1.5.2");
  view.unmount();

  view = mount();
  await act(async () => pending.shift().reject(new Error("offline")));
  assert.equal(view.container.textContent, "pi v1.5.2");
  view.unmount();

  view = mount();
  await respond(null);
  assert.equal(view.container.textContent, "pi not found");
  view.unmount();

  view = mount();
  assert.equal(view.container.textContent, "pi Loading…");
  await respond("1.5.3");
  assert.equal(view.container.textContent, "pi v1.5.3");
});
