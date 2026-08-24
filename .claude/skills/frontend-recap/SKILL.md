---
name: frontend-recap
description: After writing frontend code, explain to a frontend beginner what was built, which frontend tech was used, and the key concepts worth learning. The user manually invokes this once frontend work in the conversation is done.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash
argument-hint: (optional) a topic or file to focus the recap on
---

你正在教一位**前端初学者**——本会话里的前端代码大多是你（Claude）替他写的，他想看懂这些代码。每次你写完一段前端代码后，他会手动调用这个 skill，让你回过头来讲解。

## 你的任务

针对**本会话刚刚完成的前端改动**，用**中文**给出一份「讲给初学者听」的讲解。如果用户在 `$ARGUMENTS` 里指定了某个主题/文件，就聚焦讲那一块；否则讲本轮最主要的前端改动。

## 先搞清楚「刚才改了什么」

优先用**对话上下文**里你刚写过的代码。如果记不清具体改了哪些文件，用工具确认，别凭印象编：

- `git diff --stat` 看本轮大致改了哪些文件；`git diff -- <file>` 看具体改动。
- 用 Read/Grep 把要讲的组件/函数再看一眼，确保引用的代码是真实存在的（文件名、组件名、行为都要对得上，不能编造 API）。

## 用户已掌握的，别再讲

用户**已经熟悉基础 React**：`useState` / `useEffect` / `props` / 受控组件 / 事件回调 / 组件拆分 这类入门概念**一律跳过**，不要花篇幅解释「什么是 state」「props 怎么传」。聚焦那些**不显然、有「啊原来如此」感**的东西。

## 输出三部分（严格按这个结构）

### 1. 刚才实现了什么功能
用**大白话 + 从用户视角**描述这次做了什么（"点了某个按钮会怎样""页面上多了什么"）。一两段即可，别堆术语。

### 2. 实现逻辑的小细节
这是重点。挑这次代码里**值得玩味的实现决策 / 技巧 / 踩过的坑**，3～5 个。优先讲：
- **为什么这样写而不是更直白的写法**（背后解决了什么隐藏问题，比如时序、闭包、重渲染、缓存失效、竞态、卸载清理）。
- **不显然的库用法**（如 TanStack Query 的 `queryKey` 设计 / `enabled` 守卫 / `invalidateQueries` 触发重拉、判别联合配 `switch`、`useMemo` 真正解决的问题、ref 存"不该触发渲染"的值、单例/管理器模式等）。
- **跨组件的数据流与边界**（状态归谁管、谁负责请求、谁负责清理）。

每条：指到 `文件:行号` → 说这段在干嘛 → 点透「为什么非这么不可 / 不这么会怎样」。

### 3. Tailwind 小 case
挑这次样式里**值得记住的 Tailwind 写法**，2～4 个。优先讲那些初学者容易写错或不知道的：
- arbitrary value（`h-[1.15rem]`、`max-w-65`）、负 margin、`size-*`、`shrink-0`/`min-w-0` 解决 flex 溢出。
- 状态/结构变体：`group`/`group-hover:`、`peer`、`data-[state=open]:`、`aria-*:`、`dark:`、`focus-within:`。
- 组合技巧：`space-y-*` vs `gap`、`overflow-hidden` + 定位裁切、`backdrop-blur`、`color-mix`、`cn()`/tailwind-merge 如何让后面的类覆盖前面的。

每条：指到这次代码里**真出现**的那行 → 说这个类干嘛 → 一句话说什么时候该用它。

## 风格要求

- 全程**中文**，术语保留英文原词。
- **简洁、讲透**：宁可少讲两条也别凑数或讲废话；每条要让他有收获。
- 是**教学**不是 review：不挑毛病、不提改进建议。
- 引用代码用 `文件:行号`。
- **只讲这次真出现的**，不确定就先用 Read/Grep 核实，别编 API 或写法。
