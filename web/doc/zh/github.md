# GitHub 集成

## 这是什么

Operon 有两条 GitHub 连接：**GitHub App** 用于任务 PR 和审查评论回传；本机 **GitHub CLI** 登录用于从审阅工具栏或[助理](assistant)创建 PR。

两者都显示在 **Settings > GitHub**。它们是独立连接；安装 App 不会让 `gh` 自动登录。

## 配置

### GitHub App

1. 在桌面端的 **Settings > Remote** 登录。
2. 在 **Settings > GitHub** 点击 **Install GitHub App**，选择允许访问的账户或组织及仓库。
3. 出现 **Link GitHub account** 时，用它关联执行集成操作的账户。
4. 在 **Repository coverage** 中检查本地项目的 GitHub remote 是否已覆盖。

App 支持任务 PR，以及把审查评论送回负责的 Agent。用 **Manage on GitHub** 管理仓库访问范围。

### GitHub CLI

在桌面端安装 `gh` 并运行 `gh auth login`。回到 **Settings > GitHub** 点 **Refresh**，检查是否已安装并登录。

手动创建 PR 使用同一份登录。Operon 不再要求你把 Personal Access Token 粘贴到设置里。

## 使用：创建 PR

审阅改动后：

1. 在带 GitHub remote 的仓库中，从审阅工具栏打开 **Create PR**。
2. 填写标题、描述、分支名和目标分支。
3. 确认创建。Operon 会准备分支、在需要时提交待提交的改动、推送，然后用 `gh` 创建 PR。
4. 打开返回的 PR 链接，在 GitHub 上审阅。

也可以让助理检查 PR 状态，或在指定工作区创建 PR。创建操作可能包含提交和推送，请在工作可以分享时再提出请求。

## 移除

**Forget** 会从 Operon 保存的连接中移除 App 安装记录。要修改或撤销安装本身，请使用 **Manage on GitHub**。CLI 的登录通过 `gh` 单独管理。
