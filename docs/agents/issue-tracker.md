# Issue tracker: GitHub

本仓库的规格、PRD 与实施任务使用 GitHub Issues 管理，所有操作默认通过 `gh` CLI 完成，目标仓库为 `shengchen1998/AI-Novel-Writer`。

## 约定

- 创建 Issue：`gh issue create --title "..." --body "..."`；多行正文使用 heredoc。
- 读取 Issue：`gh issue view <number> --json number,title,body,labels,comments`。
- 列出 Issue：使用 `gh issue list`，按需添加 `--label` 和 `--state` 过滤。
- 建立父子关系：优先使用 GitHub 原生 sub-issue；不可用时，在子 Issue 正文顶部写 `Part of #<parent>`。
- 记录依赖：优先使用 GitHub 原生 issue dependencies；不可用时，在子 Issue 正文顶部写 `Blocked by: #<n>, #<n>`。所有阻塞项关闭后，ticket 才可开始。
- 评论：`gh issue comment <number> --body "..."`。
- 添加或移除标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`。
- 关闭：先评论说明原因，再执行 `gh issue close <number>`。
- 规格 Issue 不因拆分实施 tickets 而自动关闭或改写。
- 在每个会话首次创建 Issue 前，用 `gh repo view --json nameWithOwner` 核对目标；只向用户自己的仓库创建 Issue。

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub PR 不作为外部需求分流入口；只有用户明确指定的 PR 才进入审查流程。GitHub 的 Issue 和 PR 共用编号，无法确定 `#42` 的类型时，先查询 PR，再查询 Issue。

## 当 Skill 要求发布或读取 ticket

- “发布到 issue tracker”：创建 GitHub Issue。
- “读取相关 ticket”：读取对应 Issue 的正文、评论和标签。

## Wayfinding

`/wayfinder` 使用一个带 `wayfinder:map` 标签的 Issue 作为地图，以 sub-issue 作为 tickets；不支持 sub-issue 时使用任务列表和 `Part of #<map>`。子 ticket 使用 `wayfinder:<type>` 标签，类型为 `research`、`prototype`、`grilling` 或 `task`。

frontier 是地图中未指派、没有开放阻塞项的第一个开放子 ticket。认领时执行 `gh issue edit <n> --add-assignee @me`；解决时先评论答案，再关闭 ticket，并把上下文链接追加到地图的 Decisions-so-far。

## 发布与合并

- 源码、规格与工作流配置通过普通 Git 提交发布。
- 安装包、更新元数据和其他大体积构建产物不得提交到 Git 或 Git LFS。
- “仅测试云端构建”产生的安装包只能作为 GitHub Actions Artifact 保存，不得自动创建或修改 Release。
