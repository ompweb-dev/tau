# Worktrees in tau

tau shows all Git worktrees of one project together. Use this when you want separate checkouts for different branches, while keeping the project's sessions grouped together. Worktrees work the same on this machine and on linked hosts: Git runs on the machine that owns the project.

## Where the Worktree Controls Are

- The **Worktrees** tab of the file panel lists the active repository's worktrees and lets you switch, create and remove them.
- The new-session screen shows a worktree selector when the selected workspace has two or more worktrees. It only switches.

The controls work only when the selected workspace is a Git repository root. Otherwise the Worktrees tab shows a short hint instead, for example when:

- The selected directory is not a Git repository.
- The selected directory is inside a repository, but not the repository root.
- Git cannot read the repository's worktree list.

If you are inside a repo subdirectory, open the repository root as the workspace to manage worktrees.

## Switching Worktrees

Switching chooses which checkout tau uses for new work in that project.

Switching worktrees affects:

- New sessions started for the project.
- The file Explorer.
- File mentions inserted from the Explorer.

It does not move an open session. Existing sessions stay grouped under the same project, and opening one moves the effective working directory back to that session's checkout.

## Creating a Worktree

Choose `New worktree…` in the Worktrees tab and enter a branch name.

tau creates the checkout at:

```text
<repo>-worktrees/<branch>
```

For example, if the main checkout is:

```text
/Users/alex/Documents/Workspace/my-project
```

and you create branch `codex/worktree-help`, the worktree is created under:

```text
/Users/alex/Documents/Workspace/my-project-worktrees/codex-worktree-help
```

If the branch already exists, tau adds a worktree for that branch. If it does not exist, tau creates the branch from the current `HEAD`.

## Removing a Worktree

Use the remove button next to a non-main worktree to remove that checkout.

Removing a worktree does not delete:

- The Git branch.
- tau session history.
- The main checkout.

If the worktree has uncommitted or untracked files, Git refuses the removal. tau then offers a force remove action. Force removal discards the uncommitted files in that checkout, so use it only when you no longer need those changes.

## Sessions and Worktrees

tau groups sessions by project root, so sessions from the main checkout and linked worktrees appear together.

Each session still remembers the working directory it was created with. That means:

- A session started in a worktree continues to use that worktree path.
- A session started in the main checkout continues to use the main checkout.
- If a worktree has been removed, old sessions from it stay visible under the project so you can still find the history.

## Troubleshooting

**I do not see any worktrees.**
Select a Git repository root as the workspace. Non-Git directories and repo subdirectories show a hint in the Worktrees tab instead of the list.

**A branch cannot be added as a worktree.**
Git allows a branch to be checked out in only one worktree at a time. Switch to the existing worktree for that branch, or remove it first.

**A removed worktree still shows up in Git.**
Git can keep prunable worktree records after a checkout disappears. tau filters those out of the list.

**The Explorer shows a different branch than the open chat.**
The Explorer follows the selected worktree. The chat follows the opened session. Click the session again to move the effective working directory back to that session's checkout.
