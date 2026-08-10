<p align="center">
  <img src="./readme-banner.png" alt="Operon" width="1200" />
</p>

<p align="center">
  <a href="https://github.com/Nickqiaoo/Operon/releases/latest"><img src="https://img.shields.io/github/v/release/Nickqiaoo/Operon?include_prereleases&label=download&color=blue" alt="Latest Release" /></a>
  <a href="https://github.com/Nickqiaoo/Operon/releases"><img src="https://img.shields.io/github/downloads/Nickqiaoo/Operon/total?color=green" alt="Downloads" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Android-lightgrey" alt="Platform" />
  <img src="https://img.shields.io/badge/price-free-brightgreen" alt="Free" />
</p>

---

A desktop UI for AI coding agents that isn't tied to any one of them.

Operon gives Claude Code, Codex, Gemini CLI, Copilot CLI and others a proper
window — tabs, per-turn diff review, a file tree, a real editor — and lets
several of them work on the same repository **together**.

It drives the official CLIs on your machine. You use whichever subscriptions you
already pay for; Operon does not resell model access, and agent execution stays
on your machine. When you connect from the web or a mobile app, remote request
and response content is end-to-end encrypted between the approved device and
your desktop.

## About this repository

This repo hosts **releases and issue tracking**. The Operon application itself is
closed source, so you won't find the app code here.

Parts of the stack are open source and can be read or self-hosted:

| Component | What it does | License |
|---|---|---|
| [operon-diff-worker](https://github.com/Nickqiaoo/operon-diff-worker) | Cloudflare Worker that renders diffs | Apache-2.0 |

Remote clients connect through Operon's Broker. The Broker only routes encrypted
traffic and does not hold the content-encryption keys.

## Multiple agents, working together

This is the part Operon is built around, rather than being a single-agent
wrapper with extra tabs.

- **Multi-agent threads** — pull two or more agents into one conversation and let
  them disagree about an approach. You moderate and decide.
- **Canvas workflows** — describe a pipeline in plain text, no code or config. A
  node starts the moment *its own* inputs are ready, not when the whole stage
  finishes, so independent branches genuinely run in parallel. Reference any
  upstream output with `{{nodeName}}`.
- **Isolated worktrees** — dispatched tasks each land in their own git worktree,
  so parallel agents never step on each other. Inspect exactly which files came
  back changed.
- **Delegation** — one agent can hand work to others, which run in background
  tabs without blocking the conversation you're in.
- **Spec-driven changes** — spec, plan and acceptance each get a human sign-off
  before work moves on, and an independent verifier agent can check the result
  before you approve it.

## Also in the app

- **Per-turn diff review** — every turn pins exactly the files it touched, so you
  read the change before it goes near a commit
- **Live context & usage tracking** — see the context window filling up while the
  agent works
- **Skills** — pluggable instruction packs, installable globally or per project
- **Long-term memory** — local hybrid vector + keyword search, so preferences and
  project facts survive across sessions
- **MCP servers** — connect any Model Context Protocol server (stdio / HTTP / SSE)
- **Browser & Computer Use** — the agent can drive a built-in browser, your own
  Chrome via an extension, or operate native macOS apps
- **Cron jobs** — schedule recurring prompts or whole workflows
- **Integrated terminal** — full PTY inside the app
- **Auto-update**

## Supported agents

Claude Code · Codex · Gemini CLI · GitHub Copilot CLI · Cursor Agent · Kimi ·
Grok · OpenCode · any custom agent speaking ACP

Bring your own subscription or API key for whichever you use.

## Download

**Desktop — macOS** (Apple Silicon & Intel), from the
[latest release](https://github.com/Nickqiaoo/Operon/releases/latest). Windows and
Linux are not available.

**Mobile** — an Android app ships as a signed APK from
[operon.chatcode.top](https://operon.chatcode.top); **iOS is in development**. The
agent keeps running on your Mac, and the phone reaches the same session — approve
a diff or steer a run from anywhere. There is also a web client and Telegram and
Slack bridges if you'd rather not install anything.

## Documentation

Full documentation is at **[operon.chatcode.top/docs](https://operon.chatcode.top/docs)**.

- [Getting Started](https://operon.chatcode.top/docs/getting-started) — installation, first workspace, connecting agents
- [Chat](https://operon.chatcode.top/docs/chat) — multi-agent chat, streaming, tool execution, attachments, session resume
- [Canvas Workflows](https://operon.chatcode.top/docs/workflow) — visual DAG editor, node types, template variables, execution monitoring
- [Skills](https://operon.chatcode.top/docs/skills) — browse, install, and create skill packs
- [MCP Servers](https://operon.chatcode.top/docs/mcp-servers) — stdio, HTTP, and SSE servers
- [Memory](https://operon.chatcode.top/docs/memory) — vector, keyword, and hybrid retrieval
- [Cron Jobs](https://operon.chatcode.top/docs/cronjob) — scheduled prompts and workflows
- [External Agents](https://operon.chatcode.top/docs/external-agents) — delegation and orchestration

## Changelog

Release notes are attached to each [release](https://github.com/Nickqiaoo/Operon/releases).

## Feedback & Issues

Found a bug or have a feature request?
[Open an issue](https://github.com/Nickqiaoo/Operon/issues).
