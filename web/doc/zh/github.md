# GitHub 集成

## 这是什么

GitHub 集成提供一把 Personal Access Token，专门用来支撑桌面里 **Create PR** 这个一键发 PR 的能力——你在文件编辑器里改完代码，点一下 Create PR，Operon 会用这把 Token 通过 GitHub REST API 直接创建分支并发 Pull Request，不需要切到终端跑 `git` 和 `gh`。

> Token 的作用域**仅限 Create PR 流程**：校验登录身份、查询仓库元信息（默认分支、是否 fork 等）、调用 `POST /repos/.../pulls` 创建 PR。它**不会**被注入给任何 AI Agent 当作 `gh` CLI 的认证凭据，也和 Operon 用 AI 自动生成提交信息的能力无关（那个能力只读本地 diff，调你已有的 AI Provider 写消息，不依赖 GitHub Token）。

## 配置

1. 在 GitHub 上生成 [Personal Access Token](https://github.com/settings/tokens)。Create PR 至少需要 `repo` scope（私有仓库必填）；公开仓库 `public_repo` 即可。
2. 进入 Operon **Settings → GitHub**。
3. 把 Token 粘贴进输入框，点击 Save。
4. 保存成功后会显示已登录的 GitHub 用户名（来自 `GET /user`）。后续 Create PR 时这个身份就是 PR 的作者。

Token 在桌面本地以加密形式持久化，不会被发送到任何外部服务器。

## 使用：Create PR

在文件编辑器里改完文件、保存、确认 diff 后：

1. 点击右上角的 **Create PR** 按钮（仅在当前仓库识别为 GitHub 远端时显示）。
2. 弹窗里填写：
   - **Title** — PR 标题
   - **Description** — PR 描述
   - **Branch name** — 默认填一个 `ai/<slug>-<MMDD>` 格式的临时分支名，可改
   - **Base branch** — 目标分支（默认是仓库的默认分支）
3. 点击 Create，Operon 会：
   - 在当前仓库创建分支并推送变更
   - 调用 GitHub API 创建 PR
   - 弹窗里给出 PR URL，可一键打开

整个过程不需要本地装 `gh` CLI。

## 移除

**Settings → GitHub** 里点击 **Delete** 即可清除已保存的 Token。Create PR 按钮在 Token 缺失时会提示先去 Settings 配置。
