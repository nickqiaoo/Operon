# Getting Started

## What is Operon

Operon is a macOS desktop application that gives you one unified interface for working with multiple AI coding agents. Instead of switching between different CLI tools and terminals, you get a single workspace where Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor, OpenCode, and custom agents all work through the same interface.

## Installation

Download the latest release from the [direct download link](/download). Operon is currently available for macOS only.

## Setting Up Your First Workspace

1. Launch Operon. You'll see the sidebar on the left with a **Workspaces** section.
2. Click **New** to add a project folder.
3. A folder picker dialog will open — select your project directory.
4. The workspace appears in the sidebar showing the folder name and current git branch.

You can add multiple workspaces and switch between them at any time. Each workspace tracks its own git status, showing live addition and deletion counts.

## Connecting an AI Agent

Operon automatically discovers locally installed CLI agents (Claude Code, Codex, Gemini CLI, GitHub Copilot, Cursor, OpenCode). If auto-discovery fails, you can manually configure the CLI path in the **Settings** page.

If you want to use a Custom Agent (which calls AI model APIs directly), you need to configure the corresponding API key in **Settings > Providers**.

## Your First Conversation

1. Select a workspace from the sidebar.
2. The chat panel opens in the center. Select an agent and model from the dropdowns above the input area.
3. Type your message and press Enter.
4. The AI responds in real-time with streaming output.

When the AI needs to read files, write code, or run commands, it will use tools. Depending on your permission mode, you may see an approval dialog — you can approve once, approve always for that tool type, or deny.

## Interface Overview

The window is organized around a left sidebar and a central work area, plus two collapsible panels you open as needed:

- **Left Sidebar** — Workspaces list and quick-access buttons for Workflow, Skills, Schedule, and Settings. Toggle it with the panel button in the top-left corner.
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

- **[Channels](channels)** — Slack-like shared spaces where multiple agents and people collaborate around a topic.
- **[Tasks](tasks)** — a project task board where humans and agents create, assign, and dispatch work that runs on isolated git branches.
- **[Spec-Driven Development](sdd)** — an optional, gated workflow that takes a change from spec → plan → acceptance before any code is written.
- **[Browser](browser)** — a built-in browser where you can annotate page elements and send them to an agent as feedback.
- **[Workflow](workflow)** — a visual canvas for chaining multiple agents into a pipeline.

You can switch the documentation and interface language between English and 中文 with the language toggle.
