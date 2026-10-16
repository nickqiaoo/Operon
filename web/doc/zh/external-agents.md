# 外部 Agent

## 这是什么

外部 Agent 让主 Agent 把工作交给另一个已配置的 Agent，在独立的工作区对话里执行。你可以打开对话、回答问题，以后继续接着做。

## 工作原理

1. Agent 和模型由你选择；没有指定时，主 Agent 会在启动前询问。
2. 创建子对话，开始执行委派的提示词。
3. 结果回传给父对话，供它继续推进。
4. 主 Agent 可以在同一对话追加指令，或停止当前回合。

从工作区聊天派活时使用该工作区。[助理](assistant)可以在多个工作区之间选择，需要时创建带独立分支的新工作区。同一工作区里的 Agent 共用文件，会互相冲突的改动应使用不同工作区。

## 可以当外部 Agent 的有哪些

可用的已配置 Agent 包括：

- **Operon** — 已配置 AI Providers 中的模型。
- **Claude Code** — Claude Code CLI。
- **Codex** — OpenAI 的编码 Agent。
- **Antigravity** — Google 的 ACP Agent。
- **GitHub Copilot** — GitHub 的编码 Agent。
- **Grok** — xAI 的 ACP Agent。
- **Cursor** — Cursor 的 ACP Agent。
- **OpenCode** — 多 Provider 编码 Agent。
- **Kimi Code** — Moonshot 的 ACP Agent。

模型与推理强度以各 Agent 当前目录为准。可用模式见[聊天](chat)；委派会话的默认模式可能与手动打开的聊天不同。

## 用大白话指挥

直接说清楚如何交接，例如：

> 用 Codex 出计划，再让 Claude Code 实现，最后用 OpenCode 审查改动。先让我选模型。

后续工作可以继续原来的 Agent 对话，保留上下文。Agent 需要决定或审批时，请你自己回答；父 Agent 不会代你批准。

## 什么时候用得上

- **代码审查** — 一个写，另一个审。
- **并行工作** — 拆开互不影响的前后端改动。
- **调研与实现** — 先比较方案，再做改动。
- **验证** — 让另一个 Agent 测试结果。

## 怎么盯着

委派卡片显示进度与结果，并可打开子对话。助理还会在 **Activity** 中显示编码工作及其工作区、模型。你可以在对应对话中查看工具调用、追加指令或停止运行。
