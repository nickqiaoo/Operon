# 外部 Agent

## 这是什么

外部 Agent 就是让当前这个 Agent 把活儿转包给别的 Agent。一件事要是太专门，或者换个模型来做效果更好，主 Agent 可以开一个子任务，让它在另一个标签页里用另一个 Provider 跑。

## 工作原理

聊着聊着，主 Agent 判断某件子任务该交给别人做。这时候：

1. 后台自动开一个新的聊天标签。
2. 外部 Agent 收到转过去的提示词，开始干活。
3. 干完之后，结果回传给原来那个对话。
4. 主 Agent 收下结果，接着往下走。

这些都发生在同一个工作区里——切一下标签就能实时看到两边各自在做什么。

## 可以当外部 Agent 的有哪些

配好的 Agent 都可以：

- **Claude Code** — 读代码读得深，带文件检查点。
- **Codex** — OpenAI 模型，代码在沙箱里跑。
- **Gemini CLI** — Google 的 Gemini，思考预算可调。
- **GitHub Copilot** — Interactive / Plan / Autopilot 三种模式，推理强度可调。
- **Grok** — xAI 的 Grok，Default / Plan / Auto / Full Access 四种模式。
- **Cursor** — Agent / Plan / Ask 三种模式，模型列表按你的账户拉取。
- **Kimi Code** — Moonshot 的 Kimi，Default / Plan / Auto / YOLO 四种模式。
- **OpenCode** — 开源模型，Provider 列表动态发现。
- **Custom** — 你配好的 Provider 里的任何模型。

## 用大白话指挥

多个 Agent 怎么配合，直接在对话里说出来就行，主 Agent 会自己安排怎么转包。比如：

> 用 Codex 的 GPT-5.4 出一份实现计划，然后照着做，最后让 Gemini 3.1 Pro 审一遍代码

主 Agent 会依次把"出计划"交给 Codex、自己执行、再把"审代码"交给 Gemini，中间不用你插手。

## 什么时候用得上

- **代码审查**：一个写，另一个审。
- **前后端分工**：前端交给一个，后端交给另一个。
- **先调研再实现**：一个查方案，一个照着实现。
- **交叉验证**：让第二个 Agent 去验第一个的结果。
- **各取所长**：拿一个模型规划，另一个模型执行。

## 怎么盯着

每个外部 Agent 都在自己的标签页里跑，过程全都看得见：提示词、它调了哪些工具、最后给出什么。父标签这边会显示转出去的是什么、回来的是什么。
