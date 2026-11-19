# tau 里的 Worktree

tau 会把同一个 Git 项目的 main checkout 和 linked worktree 放在同一个项目下。你可以用它在不同分支之间切换工作目录，同时保留统一的会话列表。worktree 在本机和已链接的主机上用法相同：Git 运行在拥有该项目的机器上。

## Worktree 控件在哪里

- 文件面板的 **工作树**（Worktrees）标签页列出当前仓库的所有 worktree，可以切换、新建和删除。
- 当所选工作区有两个或以上 worktree 时，新建会话界面会显示一个 worktree 选择器，它只用于切换。

只有当所选工作区是 Git 仓库根目录时，这些控件才可用。否则工作树标签页只显示一行提示，例如：

- 当前目录不是 Git 仓库。
- 当前目录在某个 Git 仓库里面，但不是仓库根目录。
- Git 无法读取这个仓库的 worktree 列表。

如果你在仓库子目录里，先把仓库根目录作为工作区打开，再管理 worktree。

## 切换 Worktree 会影响什么

切换决定 tau 接下来在这个项目里使用哪个 checkout。

它会影响：

- 为这个项目新建的会话。
- Explorer 浏览的文件。
- 从 Explorer 插入到输入框里的文件路径。

它不会移动已打开的会话。已有会话仍然按同一个 project root 分组；打开一个已有会话时，有效工作目录会回到这个会话原本所在的 checkout。

## 新建 Worktree

在工作树标签页里选择 `新建工作树…`，输入 branch name。

tau 会把 checkout 放在：

```text
<repo>-worktrees/<branch>
```

例如 main checkout 是：

```text
/Users/alex/Documents/Workspace/my-project
```

新建 `codex/worktree-help` 时，目录会是：

```text
/Users/alex/Documents/Workspace/my-project-worktrees/codex-worktree-help
```

如果这个 branch 已存在，tau 会为它添加 worktree。如果 branch 不存在，tau 会从当前 `HEAD` 创建这个 branch。

## 删除 Worktree

非 main worktree 右侧有删除按钮。它删除的是这个 checkout 目录。

删除 worktree 不会删除：

- Git branch。
- tau 的历史会话。
- main checkout。

如果 worktree 里有未提交或未跟踪文件，Git 会拒绝删除。tau 会再显示 force remove。force remove 会丢弃这个 checkout 里的未提交文件，只在确定不需要这些改动时使用。

## 会话和 Worktree 的关系

tau 按 project root 分组会话，所以 main checkout 和 linked worktree 里的会话会显示在一起。

但每个会话仍然记得自己创建时的 working directory：

- 在某个 worktree 创建的会话，会继续使用那个 worktree path。
- 在 main checkout 创建的会话，会继续使用 main checkout。
- 如果某个 worktree 已被删除，它的历史会话仍会显示在项目下，方便你找回上下文。

## 常见问题

**为什么我看不到任何 worktree？**
请确认当前工作区是 Git 仓库根目录。非 Git 目录和仓库子目录会在工作树标签页显示一行提示，而不是列表。

**为什么某个 branch 不能创建 worktree？**
Git 不允许同一个 branch 同时被多个 worktree checkout。你可以切到已有的 worktree，或者先删除那个 checkout。

**Git 里还有已经消失的 worktree 记录怎么办？**
Git 有时会保留 prunable worktree 记录。tau 会过滤这些记录，不在列表里显示。

**Explorer 和当前聊天看起来不在同一个分支？**
Explorer 跟随当前选择的 worktree；聊天跟随打开的会话。重新点击会话，可以把有效工作目录切回这个会话所在的 checkout。
