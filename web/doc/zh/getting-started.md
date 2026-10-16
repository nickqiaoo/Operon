# 快速上手

## Operon 是什么

Operon 是一个 macOS 桌面应用，把 AI Agent 和个人助理放在同一个界面。Claude Code、Codex、Antigravity、GitHub Copilot、Grok、Cursor、OpenCode、Kimi Code 和内置 Operon Agent 都能在这里使用。助理可以处理日常任务，也能协调不同项目的工作。

## 安装

从网站的[直接下载链接](/download)拿最新版。桌面应用运行在 macOS 上；也可以通过[移动端](mobile)或[网页端](remote-access)远程连接。

## 建第一个工作区

1. 打开 Operon，左侧边栏里能看到 **Workspaces**。
2. 点 **New** 添加一个项目文件夹。
3. 在弹出的选择框里挑你的项目目录。
4. 工作区就出现在侧边栏了，上面写着文件夹名和当前的 git 分支。

工作区可以加很多个，随时切换。每个工作区各自盯着自己的 git 状态，实时显示改了多少行、删了多少行。

## 接上一个 Agent

本机装好的 CLI Agent（Claude Code、Codex、GitHub Copilot、Grok、Cursor、OpenCode、Kimi Code），Operon 会自己找到。要是没找着，去 **Settings** 手动填一下 CLI 路径。

Antigravity 通过 **Settings > Antigravity** 安装 ACP 服务端并检查登录。内置 Operon Agent 的模型访问在 **Settings > AI Providers** 配置。

## 第一次对话

1. 在侧边栏选一个工作区。
2. 聊天面板在中间打开。在输入框上方的下拉框里选 Agent 和模型。
3. 输入内容，回车发送。
4. 回复是一边生成一边显示的。

当 AI 需要读文件、写代码或执行命令时，它会调用工具。视你的权限模式而定，可能会显示审批请求。可选操作取决于 Agent 和工具；待处理请求也会出现在 Inbox。

## 界面速览

窗口分成左侧边栏和中间的工作区，另外还有两个随用随开的面板：

- **左侧边栏** — 工作区列表、Assistant 和 Inbox，以及 Workflow、Plugins、Schedule、Settings 的入口。技能在 Settings 管理。点左上角的面板按钮可以收起来。
- **中间** — 主标签区，聊天、文件预览和 diff 都在这儿。
- **右侧面板** — 从中间区域旁边滑出来的标签面板，⌘\ 开关。
- **底部面板** — 从底下滑上来的标签面板，⌘J 开关。

右侧和底部面板共用一套标签系统。下面这些标签在哪个面板都能开，可以拖动排序，也可以从一个面板拖到另一个：

- **Files** — 文件树，支持直接预览。
- **Review** — 当前工作区的多文件 git diff。
- **Browser** — 内置浏览器。
- **Terminal** — 一个 shell，起始目录就是当前工作区。

每个工作区都记着自己开过哪些标签，切回来时原样恢复。

## 不只是一对一聊天

Operon 不止是个聊天框。基本对话用顺手之后，可以看看这些：

- **[助理](assistant)** — 一条持续的个人对话，带记忆、后台检查、定时任务和跨工作区的编码 Agent 调度。
- **[频道](channels)** — 类似 Slack 的共享空间，多个 Agent 和人围绕一个主题一起干活。
- **[任务](tasks)** — 项目级的任务看板，人和 Agent 一起建任务、派活，活儿在独立的 git 分支上跑。
- **[规格驱动开发](sdd)** — 可选的带关卡的流程：规格和计划批准后再实现，完成后进行验收。
- **[浏览器](browser)** — 内置浏览器，可以在网页元素上写批注，直接发给 Agent。
- **[工作流](workflow)** — 用画布搭建流水线，也可以在聊天中让 Agent 编排工作流。

文档用语言按钮切换；应用语言在 **Settings > Appearance** 设置。
