# 聊天

## 这是什么

聊天提供与 AI Agent 的流式对话，支持工具执行、文件操作、权限控制和会话历史。需要跨项目的持续个人对话时，见[助理](assistant)。

## 工作原理

在输入框上方选择 Agent 和模型。Operon 目前集成九种 Agent：

- **Operon** — 内置 Agent，支持 [AI Providers](providers)、工具、技能、MCP 和记忆。权限模式为 Manual、Workspace、Auto、YOLO。
- **Claude Code** — 提供 Default、Auto、Accept Edits、Plan、Bypass、Don't Ask 模式，思考控制取决于模型。
- **Codex** — 提供 Request Approval、Approve for Me、Full Access、Plan 模式，以及沙箱执行和 Goal 模式。
- **Antigravity** — Google 的 ACP Agent，提供 Default、Auto Edit、YOLO 模式。在 **Settings > Antigravity** 安装服务端并检查登录。
- **GitHub Copilot** — 提供 Normal、Plan、Autopilot 模式，模型和推理控制取决于账户。
- **Grok** — ACP 接入，提供 Default、Plan、Auto、Full Access 模式。
- **Cursor** — ACP 接入，提供 Agent、Plan、Ask 模式。
- **OpenCode** — 多 Provider Agent，提供 Build、Plan、Full Access 模式。
- **Kimi Code** — ACP 接入，提供 Default、Plan、Auto、YOLO 模式。

模型列表与可用控制取决于 Agent、已安装版本和账户。每个聊天独立保存跨消息的会话上下文。

### ACP Agent

Antigravity、Grok、Cursor、Kimi Code 使用 **Agent Client Protocol**（ACP）。Operon 在同一个聊天界面中呈现它们的流式回复、工具调用、权限请求、模型与模式控制、会话历史和可用命令。实际显示哪些控制取决于各 Agent 的支持情况。

## 功能

### 多 Agent

不同对话可以选择不同 Agent 和模型。需要一个 Agent 把活交给另一个时，见[外部 Agent](external-agents)。

### 流式回复

AI 回复随着生成实时显示。

### 工具与权限

Agent 可以读文件、改代码、跑命令。需要审批时，聊天中会显示请求；可选操作取决于 Agent 和工具。待处理请求也会出现在 [Inbox](notifications)。

运行模式决定默认行为：

- **Manual / Default / Request Approval / Normal**：需要权限时询问。
- **Workspace / Accept Edits / Auto Edit**：允许特定编辑，其余检查仍然保留。
- **Auto / Approve for Me**：由 Agent 审查动作，必要时交给你决定。
- **Plan / Ask**：侧重规划或问答，限制因 Agent 而异。
- **Bypass / Full Access / YOLO / Autopilot**：按照各 Agent 的模式取消审批提示，请有意识地选择。

### 附件

用附件按钮添加文件。文本文件提供上下文；支持的 Agent 也可以接收图片。

### 用 @ 引用文件

输入 `@` 搜索并引用工作区文件，文件内容会提供给 Agent。

### 中途插话

支持的 Agent 可以在运行中接收后续消息；其余 Agent 会把消息排到当前回合结束后处理。

### 接着上次继续

打开已有对话，可以从保存的会话历史继续。

### 检查点与回退

Operon 会为聊天回合保存工作区检查点。使用回退查看并恢复之前回合的改动，确认前先审阅受影响的文件。

### 斜杠命令

输入 `/` 查看可用命令，包括支持时的 `/compact`。列表因 Agent 而异，也可能包含技能。

### 思考强度

支持的 Agent 和模型提供推理强度控制，可用级别因模型而异。

### Goal（目标）模式

Codex 支持 **Goal** 模式：给它一个跨回合推进的目标。目标横幅显示状态、目标、用时与 token 消耗。你可以暂停、恢复或清除目标；用量或预算上限也可能使其停止。
