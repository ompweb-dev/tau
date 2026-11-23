// NOTE: this module used to also record the last-open session per project
// (get/set/clearLastOpenSession, localStorage key "tau:last-open-by-project").
// No caller ever read the recorded value back — project activation is
// deliberately selection-only (see activateProject in SessionSidebar: it sets
// the selected workspace, it never opens a session) — so the helpers were
// dead writes on every selection and were removed rather than wired into a
// behavior change. Any value already stored under that key is orphaned and
// never read.

export function workspaceKeyOf(workspace: { cwd?: string; path?: string; projectRoot?: string; projectKey?: string; poolId?: string; projectId?: string }): string {
  if (workspace.poolId && workspace.projectId) {
    // Empty strings count as missing, not as a key: hand-edited or partially
    // written session headers can carry "" where a field is absent, and ??
    // would keep the empty string, grouping the session under no project.
    return workspace.projectKey || `pool:${workspace.poolId}:${workspace.projectId}`;
  }
  return workspace.projectKey || workspace.projectRoot || workspace.cwd || workspace.path || "";
}
