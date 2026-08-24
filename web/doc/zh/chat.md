# 聊天

## 这是什么

聊天是核心交互界面，提供与多个 AI Agent 进行流式对话的体验，支持工具执行、文件操作、权限控制和会话管理。

## 工作原理

Operon 支持九种 AI Agent，每种 Agent 有不同的底层架构和特性：

- **Operon Agent**（原生 · 多 Provider）— Operon 自研的 Agent，而非套壳外部 CLI（在 **Settings > Providers** 中配置为 *Custom Agent*）。基于 AI SDK 的 Agent 循环，聚合 8+ 家模型 Provider——Anthropic、OpenAI、Google、DeepSeek、Kimi、GLM、MiniMax、Grok——统一接入内置工具系统，内建 skills、MCP 和记忆。
- **Claude Code**（Anthropic）— 深度集成 Claude Code CLI。支持多种权限模式以实现安全的自主编码，可调节思考级别，提供子 Agent、问答工具和斜杠命令的丰富 UI。支持对话中途切换模型和模式，体验与 CLI 一致。
- **Codex**（OpenAI）— 基于 Codex App Server 构建，支持完整的会话管理。Plan 模式可在执行前审查变更，丰富的子 Agent UI 渲染，以及沙箱隔离确保安全编码。采用与 Codex Desktop 相同的接入机制，享受 2 倍 API 额度。支持 **Goal**（目标）模式（见下文）。
- **Gemini CLI**（Google）— 基于 Gemini Core 源码构建，完全兼容所有 Gemini CLI 能力。支持 OAuth 认证，提供子 Agent 和所有工具调用的丰富 UI 渲染。
- **GitHub Copilot**（GitHub）— 基于 Copilot SDK 构建。支持 Interactive（逐操作审批）、Plan、Autopilot（自主执行）三种模式，可配置推理强度，模型列表按你的套餐实时拉取。
- **Grok**（xAI）— 通过 **ACP** 接入（见下文）。支持 Default / Plan / Auto / Full Access 四种模式，模型列表实时拉取，逐轮 token 统计，并复用通用 `skills` 约定加载技能。
- **Cursor**（Cursor）— 通过 **ACP** 接入。支持 Agent、Plan、Ask 三种模式，模型列表（Composer、Codex、Opus 等）按你的账户实时拉取。
- **OpenCode**（Open Source）— 基于 OpenCode SDK 构建，功能完全对齐。支持 GLM、DeepSeek 等多种 Provider，提供所有工具调用的丰富 UI 渲染。
- **Kimi Code**（Moonshot）— 通过 **ACP** 接入。支持 Default / Plan / Auto / YOLO 四种模式（YOLO 自动批准一切），提供 `/compact` 等斜杠命令。

当你发送消息时，消息通过 Server-Sent Events (SSE) 流式传输到后端，后端将其路由到所选 Agent。Agent 调用 AI 模型，并将响应实时流式返回。系统按对话维护会话——AI 在同一对话中跨消息保持上下文。

### ACP Agent

Grok、Cursor 和 Kimi Code 都使用 **Agent Client Protocol**（ACP）——最早由 Zed 提出的、与具体 Agent 无关的开放 JSON-RPC 协议。Operon 以各自的 ACP 模式启动这些 CLI（`grok agent stdio`、`cursor-agent acp`、`kimi acp`），再通过同一套共享客户端层与它们通信，因此三者拥有完全一致的能力：流式输出与思考过程、带权限确认的工具调用、模式与模型切换、会话恢复、MCP 服务器，以及 `/` 命令菜单。

这样做的好处是：这些 Agent 不需要各写一套定制集成。任何提供 ACP 端点的工具都能以相同方式接入，每个 Provider 只需描述自己不同的部分——有哪些模式、如何暴露模型列表、如何上报 token 用量。

## 功能

### 多 Agent

同一个界面里随时换 Agent、换模型。每个 Agent 能用的模型、运行模式和本事都不太一样。

### 流式回复

回复是一边生成一边显示的，不用干等。

### 工具与权限

AI 会用工具来读文件、写文件、跑命令。碰到需要你点头的工具，会弹一个确认框：可以只批这一次、以后这类都批，或者直接拒绝。

默认要不要问你，取决于当前的运行模式：
- 严的模式，大部分动作都会先问一声。
- 松的模式，安全的操作直接放行。

### 附件

用附件按钮把文件带进消息里，文本文件的内容会一并交给 AI。

### 用 @ 引用文件

在输入框里打 `@`，就能搜工作区里的文件并引用它，AI 会读到文件内容。

### 中途插话

有些 Agent 支持往正在进行的会话里塞一条消息，适合它跑到一半时补充点情况。

### 接着上次继续

对话可以隔一段时间再回来接着聊，会话状态一直留着。

### 检查点与回退

支持的 Agent 会在每条消息之前给文件拍一张快照。你可以退回到之前任意一个检查点，把 AI 的改动撤掉。

### 斜杠命令

在输入框里打 `/` 能看到这个 Agent 支持的命令：
- `/compact` — 把对话压缩一下，腾出上下文空间。

具体有哪些命令，各家不一样。

### 思考强度

有些 Agent 可以调思考强度（低、中、高），也就是它回答之前愿意花多少心思想。

### Goal（目标）模式

Codex 支持 **Goal（目标）** 模式：不再是一问一答的单轮对话，而是给 Agent 一个目标，它会跨多轮自主推进，直到目标达成。输入框上方的目标横幅会实时显示状态（进行中、已暂停，或因用量/预算上限停止）、目标内容，以及已消耗的时间和 token。你可以随时暂停、恢复或清除目标。
