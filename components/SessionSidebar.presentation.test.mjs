import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
const { act, render, cleanup, fireEvent, screen, waitFor } = await import("@testing-library/react/pure.js");
const { SessionSidebar } = await import("./SessionSidebar.tsx");
const { ProjectRow } = await import("./SessionSidebar-rows.tsx");
const { toast } = await import("./ui/toast.tsx");
const { translate } = await import("../lib/i18n/index.tsx");

// The event-stream transport keeps the first worker it was given for the whole file.
const workers = [];
class FakeWorker {
  posted = [];
  constructor() { workers.push(this); }
  postMessage(message) { this.posted.push(message); }
}

test("failed workspace rename is reported without an unhandled rejection; failed launch save stays open", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia, error: toast.error };
  const errors = [];
  const writes = [];
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  toast.error = (message) => { errors.push(message); };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/projects") {
      if (init.method === "PATCH") {
        writes.push(JSON.parse(init.body));
        return Response.json({ error: "Workspace update refused", code: "workspace_write_refused" }, { status: 400 });
      }
      return Response.json({ projects: [{ path: "/workspace", launchConfig: { extraArgs: ["--verbose"] } }] });
    }
    if (url.pathname === "/api/sessions") return Response.json({ sessions: [] });
    return Response.json({});
  };
  try {
    render(React.createElement(SessionSidebar, {
      selectedSessionId: null, selectedCwd: "/workspace", skipInitialProjectSelection: true,
      onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    }));
    await waitFor(() => assert.ok(screen.getByTitle("/workspace")));
    fireEvent.click(screen.getByRole("button", { name: translate("commandPalette.actions") }));
    fireEvent.click(screen.getByRole("menuitem", { name: translate("projects.nameAlias") }));
    const alias = screen.getByRole("textbox", { name: translate("projects.aliasPrompt") });
    fireEvent.change(alias, { target: { value: "New name" } });
    fireEvent.keyDown(alias, { key: "Enter" });
    await waitFor(() => assert.deepEqual(errors, ["Workspace update refused"]));
    assert.equal(writes[0].alias, "New name");
    assert.ok(screen.getByTitle("/workspace"), "the failed rename does not replace the displayed workspace");

    fireEvent.click(screen.getByRole("button", { name: translate("commandPalette.actions") }));
    fireEvent.click(screen.getByRole("menuitem", { name: translate("sessionSidebar.editLaunchConfig") }));
    fireEvent.click(screen.getByRole("button", { name: translate("projectLaunchConfig.save") }));
    await waitFor(() => assert.equal(errors.length, 2));
    assert.deepEqual(writes[1].launchConfig.extraArgs, ["--verbose"]);
    await waitFor(() => assert.equal(screen.getByRole("alert").textContent, "Workspace update refused"));
    assert.ok(screen.getByRole("button", { name: translate("projectLaunchConfig.save") }), "the dialog remains open for correction or retry");
  } finally {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
    toast.error = original.error;
  }
});

test("a pinned project row names its node; other rows carry no node label", () => {
  const noop = () => {};
  const row = (extra) => React.createElement(ProjectRow, {
    project: { path: "/srv/app", hostId: "h1" }, isActive: false, isExpanded: false, activity: undefined, tree: [], hiddenCount: 0,
    selectedSessionKey: null, runningSessionIds: new Set(), unreadSessionIds: new Set(), exitedSessions: new Map(), relativeTimeNow: 0,
    onActivate: noop, onToggleExpand: noop, onRemoveProject: noop, onEditLaunchConfig: noop, onUpdatePresentation: noop,
    onDragProjectChange: noop, onDropProject: noop, onMoveProject: noop, pinnable: false, onTogglePin: noop, isDragTarget: false,
    removeBusy: false, onSelectSession: noop, ...extra,
  });
  try {
    render(row({ node: { label: "Build box" } }));
    const button = screen.getByRole("button", { name: new RegExp(translate("hosts.onNode", { node: "Build box" })) });
    assert.equal(button.getAttribute("aria-describedby"), null, "an online node adds no description");
    assert.equal(screen.getByText("Build box").getAttribute("title"), translate("hosts.onNode", { node: "Build box" }));
    cleanup();
    const { container } = render(row({ node: { label: "Build box", statusText: "offline", unavailableReason: "Build box is offline." } }));
    const offline = screen.getByRole("button", { name: /On Build box/ });
    assert.equal(container.querySelector(`[id="${offline.getAttribute("aria-describedby")}"]`)?.textContent, "Build box is offline.");
    assert.ok(offline.getAttribute("title").endsWith("Build box is offline."));
    assert.equal(container.querySelector("section").style.opacity, "0.55");
    assert.ok(container.textContent.includes("Build box · offline"));
    cleanup();
    render(row({}));
    assert.equal(screen.queryByText("Build box"), null);
  } finally {
    cleanup();
  }
});

test("a session row is selected only for its own host's copy of the id, nested rows included", () => {
  const noop = () => {};
  const none = new Set();
  const exited = new Map();
  const session = (id, name) => ({ id, hostId: "h1", path: `/x/${id}.jsonl`, cwd: "/srv/app", name, firstMessage: "", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 1 });
  // One tree for every render: only the selection changes, so the rows' memo comparators decide.
  const tree = [{ session: session("s1", "Copied"), children: [{ session: session("c1", "Child"), children: [] }] }];
  const props = (selectedSessionKey) => ({
    project: { path: "/srv/app", hostId: "h1" }, isActive: true, isExpanded: true, activity: undefined, tree, hiddenCount: 0,
    selectedSessionKey, runningSessionIds: none, awaitingInputIds: none, unreadSessionIds: none, exitedSessions: exited, relativeTimeNow: 0,
    onActivate: noop, onToggleExpand: noop, onRemoveProject: noop, onEditLaunchConfig: noop, onUpdatePresentation: noop,
    onDragProjectChange: noop, onDropProject: noop, onMoveProject: noop, pinnable: false, onTogglePin: noop, isDragTarget: false,
    removeBusy: false, onSelectSession: noop,
  });
  const current = (name) => screen.getByRole("button", { name }).getAttribute("aria-current");
  try {
    const { rerender } = render(React.createElement(ProjectRow, props("local/s1")));
    assert.equal(current("Copied"), null);
    rerender(React.createElement(ProjectRow, props("h1/s1")));
    assert.equal(current("Copied"), "true");
    rerender(React.createElement(ProjectRow, props("h1/c1")));
    assert.equal(current("Copied"), null);
    assert.equal(current("Child"), "true", "a nested row follows the selection");
    rerender(React.createElement(ProjectRow, props("local/c1")));
    assert.equal(current("Child"), null, "not for another host's copy");
  } finally {
    cleanup();
  }
});

test("the sidebar selects the selected host's copy of a session id, not this machine's", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const copy = (hostId, name) => ({ id: "s1", hostId, path: "/x/s1.jsonl", cwd: "/srv/app", name, firstMessage: "", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 1 });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/hosts") return Response.json({ hosts: [{ id: "local", label: "", status: "online" }, { id: "h1", label: "Build box", status: "online" }], pools: [] });
    if (url.pathname === "/api/projects") return Response.json({ projects: [{ path: "/srv/app", hostId: "local" }, { path: "/srv/app", hostId: "h1" }] });
    if (url.pathname === "/api/sessions") return Response.json({ sessions: [copy("local", "Here"), copy("h1", "There")] });
    return Response.json({});
  };
  // Both copies' projects are expanded, so both rows render.
  localStorage.setItem("tau:expanded-projects", JSON.stringify(["/srv/app", "h1:/srv/app"]));
  try {
    render(React.createElement(SessionSidebar, {
      selectedSessionId: "s1", selectedHostId: "h1", selectedCwd: "/srv/app", skipInitialProjectSelection: true,
      onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    }));
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "There" }).getAttribute("aria-current"), "true"));
    assert.equal(screen.getByRole("button", { name: "Here" }).getAttribute("aria-current"), null, "this machine's copy is not selected");
  } finally {
    cleanup();
    localStorage.removeItem("tau:expanded-projects");
    Object.assign(globalThis, { fetch: original.fetch, Worker: original.Worker, SharedWorker: original.SharedWorker });
    window.matchMedia = original.matchMedia;
  }
});

test("running, needs-input, stopped and finished marks show only on the host copy of a session id that has them", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const copy = (hostId, name) => ({ id: "s1", hostId, path: "/x/s1.jsonl", cwd: "/srv/app", name, firstMessage: "", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 1 });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/hosts") return Response.json({ hosts: [{ id: "local", label: "", status: "online" }, { id: "h1", label: "Build box", status: "online" }], pools: [] });
    if (url.pathname === "/api/projects") return Response.json({ projects: [{ path: "/srv/app", hostId: "local" }, { path: "/srv/app", hostId: "h1" }] });
    if (url.pathname === "/api/sessions") return Response.json({ sessions: [copy("local", "Here"), copy("h1", "There")], runningSessions: [] });
    return Response.json({});
  };
  localStorage.setItem("tau:expanded-projects", JSON.stringify(["/srv/app", "h1:/srv/app"]));
  const status = (name) => document.getElementById(screen.getByRole("button", { name }).getAttribute("aria-describedby")).textContent;
  const running = (frame) => {
    const worker = workers[0];
    const open = worker.posted.findLast((message) => message.op === "open" && message.channel.kind === "running");
    act(() => worker.onmessage({ data: { id: open.id, type: "message", data: JSON.stringify({ type: "running", exitedSessions: [], ...frame }) } }));
  };
  try {
    render(React.createElement(SessionSidebar, {
      selectedSessionId: null, skipInitialProjectSelection: true,
      onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    }));
    await waitFor(() => assert.ok(screen.getByRole("button", { name: "There" })));
    await waitFor(() => assert.ok(workers[0]?.posted.some((message) => message.op === "open" && message.channel.kind === "running")));
    running({ runningSessions: [{ id: "s1", cwd: "/srv/app", hostId: "h1" }] });
    await waitFor(() => assert.match(status("There"), new RegExp(translate("sessionSidebar.statusRunning"))));
    assert.match(status("Here"), new RegExp(translate("sessionSidebar.statusReady")), "this machine's copy is not running");
    running({ runningSessions: [{ id: "s1", cwd: "/srv/app", hostId: "h1", awaitingInput: true }] });
    await waitFor(() => assert.match(status("There"), new RegExp(translate("sessionSidebar.statusNeedsInput"))));
    assert.match(status("Here"), new RegExp(translate("sessionSidebar.statusReady")));
    // The run ends unseen: only that copy is finished and unread.
    running({ runningSessions: [] });
    await waitFor(() => assert.match(status("There"), new RegExp(translate("sessionSidebar.statusDone"))));
    assert.match(status("Here"), new RegExp(translate("sessionSidebar.statusReady")));
    assert.deepEqual(JSON.parse(localStorage.getItem("tau:unread-session-ids")), ["h1/s1"]);
    running({ runningSessions: [], exitedSessions: [{ id: "s1", cwd: "/srv/app", hostId: "h1", at: 1, code: 1, signal: null, detail: "" }] });
    await waitFor(() => assert.match(status("There"), new RegExp(translate("sessionSidebar.statusStopped"))));
    assert.match(status("Here"), new RegExp(translate("sessionSidebar.statusReady")));
  } finally {
    cleanup();
    localStorage.removeItem("tau:expanded-projects");
    localStorage.removeItem("tau:unread-session-ids");
    Object.assign(globalThis, { fetch: original.fetch, Worker: original.Worker, SharedWorker: original.SharedWorker });
    window.matchMedia = original.matchMedia;
  }
});

test("the sidebar orders a cluster's pool projects and its members' projects as one list, and marks an offline node", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const hostRows = [
    { id: "local", label: "", status: "online" },
    { id: "h1", label: "Build box", status: "offline", hostVersion: null, serverVersion: 9 },
  ];
  const pools = [{ id: "cluster", label: "Cluster", enabled: true, members: [{ hostId: "local" }, { hostId: "h1" }], projects: [] }];
  const writes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/hosts") return Response.json({ hosts: hostRows, pools });
    if (url.pathname === "/api/projects" && init.method === "PATCH") {
      const body = JSON.parse(init.body);
      writes.push(body);
      // The first store refuses: the others are still written.
      return body.poolId ? Response.json({ error: "Pool registry unavailable" }, { status: 503 }) : Response.json({ projects: [] });
    }
    if (url.pathname === "/api/projects") {
      return Response.json({ projects: [
        { path: "/a", hostId: "h1", sortOrder: 2 },
        { path: "/l", hostId: "local", sortOrder: 0 },
        { path: "pool:cluster:x", poolId: "cluster", projectId: "x", name: "shared", origin: "git@example.com:o/shared.git", sortOrder: 1 },
      ] });
    }
    if (url.pathname === "/api/sessions") return Response.json({ sessions: [] });
    return Response.json({});
  };
  try {
    const { container } = render(React.createElement(SessionSidebar, {
      selectedSessionId: null, skipInitialProjectSelection: true,
      onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    }));
    await waitFor(() => assert.equal(container.querySelectorAll(".sidebar-project-identity").length, 3));
    const names = [...container.querySelectorAll(".sidebar-project-identity")].map((button) => button.textContent);
    // Manual order across the pool's registry and each member's: no store goes first.
    assert.deepEqual(names.map((name) => name[0]), ["l", "s", "a"], names.join(" | "));
    const pinned = screen.getByRole("button", { name: /On Build box/ });
    assert.ok(pinned.textContent.includes(translate("hostsConfig.statusOffline")), "an offline node shows its status");
    const reason = container.querySelector(`[id="${pinned.getAttribute("aria-describedby")}"]`);
    assert.ok(reason?.textContent.includes("Build box"), "the button is described by the unavailable reason");
    assert.ok(screen.queryByRole("button", { name: /On This machine/ }), "this machine's pinned project names its node");

    // Moving this machine's project below the pool's one writes the moved positions, one batch per store; the
    // offline member's project keeps its position, so its store gets no request.
    const errors = [];
    const originalError = toast.error;
    toast.error = (message) => { errors.push(message); };
    try {
      fireEvent.click(container.querySelectorAll(`[aria-label="${translate("commandPalette.actions")}"]`)[0]);
      fireEvent.click(await screen.findByRole("menuitem", { name: translate("projects.moveDown") }));
      await waitFor(() => assert.equal(errors.length, 1));
      assert.deepEqual(errors, [translate("projects.reorderFailed")]);
      assert.deepEqual(writes, [
        { poolId: "cluster", updates: [{ projectId: "x", sortOrder: 0 }] },
        { updates: [{ cwd: "/l", sortOrder: 1 }] },
      ]);
      // Moving the offline member's own project would change its store: refused before anything is written.
      fireEvent.click(container.querySelectorAll(`[aria-label="${translate("commandPalette.actions")}"]`)[2]);
      fireEvent.click(await screen.findByRole("menuitem", { name: translate("projects.moveUp") }));
      await waitFor(() => assert.equal(errors.length, 2));
      assert.match(errors[1], /Build box/);
      assert.equal(writes.length, 2, "nothing written for a move that needs an offline member");
    } finally {
      toast.error = originalError;
    }
  } finally {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
  }
});

test("the sidebar refetches its projects and sessions when the loaded pools change, not on their first load or an unchanged frame", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // The remote host stays offline: nothing comes online, which refetches on its own.
  const hosts = [{ id: "local", label: "", status: "online" }, { id: "h1", label: "Build box", status: "offline", hostVersion: null, serverVersion: 9 }];
  const cluster = (...hostIds) => [{ id: "cluster", label: "Cluster", enabled: true, members: hostIds.map((hostId) => ({ hostId })), projects: [] }];
  let projectLoads = 0;
  let sessionLoads = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/hosts") return Response.json({ hosts, pools: cluster("local") });
    if (url.pathname === "/api/projects") {
      projectLoads++;
      return Response.json({ projects: [] });
    }
    if (url.pathname === "/api/sessions") {
      sessionLoads++;
      return Response.json({ sessions: [] });
    }
    return Response.json({});
  };
  try {
    render(React.createElement(SessionSidebar, {
      selectedSessionId: null, skipInitialProjectSelection: true,
      onSelectSession() {}, addProjectOpen: false, setAddProjectOpen() {}, usageVisible: false,
    }));
    await screen.findByRole("region", { name: "Cluster" });
    assert.equal(projectLoads, 1, "loading the pools does not fetch the projects again");
    const { id } = workers[0].posted.findLast((message) => message.op === "open" && message.channel.kind === "hosts");
    const frame = (pools) => act(() => workers[0].onmessage({ data: { id, type: "message", data: JSON.stringify({ hosts, pools }) } }));
    const sessionsBefore = sessionLoads;
    frame(cluster("local"));
    assert.equal(projectLoads, 1, "a frame with the same pools");
    assert.equal(sessionLoads, sessionsBefore, "a frame with the same pools");
    // The server tags sessions with the cluster's bindings: they move to the new projects only when fetched again.
    frame(cluster("local", "h1"));
    assert.equal(projectLoads, 2, "a host joined");
    assert.equal(sessionLoads, sessionsBefore + 1, "a host joined");
  } finally {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
  }
});
