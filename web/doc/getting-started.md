# Getting Started

## What is Operon

Operon is a macOS desktop application for working with AI agents and a personal Assistant. Claude Code, Codex, Antigravity, GitHub Copilot, Grok, Cursor, OpenCode, Kimi Code, and the built-in Operon agent share one interface. Assistant helps with everyday tasks and coordinates work across your projects.

## Installation

Download the latest release from the [direct download link](/download). The desktop app runs on macOS; use the [mobile apps](mobile) or [web client](remote-access) to reach it remotely.

## Setting Up Your First Workspace

1. Launch Operon. You'll see the sidebar on the left with a **Workspaces** section.
2. Click **New** to add a project folder.
3. A folder picker dialog will open — select your project directory.
4. The workspace appears in the sidebar showing the folder name and current git branch.

You can add multiple workspaces and switch between them at any time. Each workspace tracks its own git status, showing live addition and deletion counts.

## Connecting an AI Agent

Operon automatically discovers locally installed CLI agents (Claude Code, Codex, GitHub Copilot, Grok, Cursor, OpenCode, Kimi Code). If auto-discovery fails, you can manually configure the CLI path in the **Settings** page.

For Antigravity, use **Settings > Antigravity** to install its ACP server and check sign-in. For the built-in Operon agent, configure model access in **Settings > AI Providers**.

## Your First Conversation

1. Select a workspace from the sidebar.
2. The chat panel opens in the center. Select an agent and model from the dropdowns above the input area.
3. Type your message and press Enter.
4. The AI responds in real-time with streaming output.

When the AI needs to read files, write code, or run commands, it will use tools. Depending on your permission mode, you may see an approval request. The available choices depend on the agent and tool; pending requests also appear in the Inbox.

## Interface Overview

The window is organized around a left sidebar and a central work area, plus two collapsible panels you open as needed:

- **Left Sidebar** — Workspaces list, Assistant and Inbox, plus Workflow, Plugins, Schedule, and Settings. Skills are managed in Settings. Toggle it with the panel button in the top-left corner.
- **Center** — The main tabbed area for chat, file preview, and diffs.
- **Right Panel** — A collapsible, tabbed panel that slides in beside the center area. Toggle it with ⌘\.
- **Bottom Panel** — A collapsible, tabbed panel that slides up from the bottom. Toggle it with ⌘J.

The right and bottom panels share the same tab system. You can open any of these tab types in either panel, drag tabs to reorder them, and even drag a tab from one panel to the other:

- **Files** — File tree browser with inline preview.
- **Review** — Multi-file Git diff for the current workspace.
- **Browser** — A built-in web browser.
- **Terminal** — A shell running in the context of your active workspace.

Each workspace remembers its own open tabs, so switching workspaces restores the panels you had open there.

## Beyond One-on-One Chat

Operon is more than a chat box. Once you're comfortable with a basic conversation, explore:

- **[Assistant](assistant)** — one ongoing personal conversation, with memory, background checks, schedules, and coding-agent dispatch across workspaces.
- **[Channels](channels)** — Slack-like shared spaces where multiple agents and people collaborate around a topic.
- **[Tasks](tasks)** — a project task board where humans and agents create, assign, and dispatch work that runs on isolated git branches.
- **[Spec-Driven Development](sdd)** — an optional, gated workflow that takes a change from spec → plan → acceptance with approvals for the spec and plan before implementation, then acceptance review afterward.
- **[Browser](browser)** — a built-in browser where you can annotate page elements and send them to an agent as feedback.
- **[Workflow](workflow)** — build pipelines on a visual canvas, or ask an agent to orchestrate a workflow from chat.

Use the language toggle for these docs. Set the app's language in **Settings > Appearance**.
