import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test, { afterEach } from "node:test";
const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react/pure.js");
const { ProjectLaunchConfigDialog } = await import("./ProjectLaunchConfigDialog.tsx");
const { translate } = await import("../lib/i18n/index.tsx");
afterEach(cleanup);

test("the launch editor exposes legacy values and saves an explicit correction or clear", async () => {
  const saved = [];
  const props = { projectPath: "/workspace", initialConfig: { extraArgs: ["--cwd", "/elsewhere"] }, onClose() {}, onSave: async (config) => { saved.push(config); } };
  const view = render(React.createElement(ProjectLaunchConfigDialog, props));
  const args = view.getByRole("textbox", { name: translate("projectLaunchConfig.extraArgsLabel") });
  assert.equal(args.value, "--cwd\n/elsewhere");
  const save = view.getByRole("button", { name: translate("projectLaunchConfig.save") });
  fireEvent.change(args, { target: { value: "--verbose" } });
  fireEvent.click(save);
  await waitFor(() => assert.deepEqual(saved[0], { extraArgs: ["--verbose"] }));
  await waitFor(() => assert.equal(save.disabled, false));
  fireEvent.change(args, { target: { value: "" } });
  fireEvent.click(save);
  await waitFor(() => assert.equal(saved[1], null));
});
