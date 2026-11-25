import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
const { cleanup, render } = await import("@testing-library/react/pure.js");

const { registerAbortHandler, useGlobalKeyboardShortcuts } = await import("./useKeyboardShortcuts.ts");

test("Esc stops the chat in front even after another chat's handler is cleared", () => {
  const view = render(React.createElement(function Shortcuts() { useGlobalKeyboardShortcuts({}); return null; }));
  const stopped = [];
  // A chat that registered earlier (now behind) clears after the one in front registered.
  const clearBehind = registerAbortHandler(() => stopped.push("behind"));
  const clearFront = registerAbortHandler(() => stopped.push("front"));
  clearBehind();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.deepEqual(stopped, ["front"]);
  // Esc in a tab group that is not the shown one is not for the shown chat.
  const otherGroup = document.createElement("div");
  otherGroup.dataset.groupFocused = "false";
  otherGroup.append(document.createElement("button"));
  document.body.append(otherGroup);
  otherGroup.firstChild.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.deepEqual(stopped, ["front"]);
  otherGroup.remove();
  clearFront();
  view.unmount();
  cleanup();
});
