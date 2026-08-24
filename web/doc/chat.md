# Chat

## What is it

Chat is the core interaction interface. It provides a streaming conversation experience with multiple AI agents, with support for tool execution, file operations, permission controls, and session management.

## How it works

Operon supports nine AI agents, each with a different underlying architecture and capabilities:

- **Operon Agent** (Native · Multi-provider) — Operon's own agent, not a wrapper around an external CLI (configured as a *Custom Agent* in **Settings > Providers**). An AI SDK-powered agent loop that aggregates 8+ model providers — Anthropic, OpenAI, Google, DeepSeek, Kimi, GLM, MiniMax, and Grok — behind a single built-in tool system, with skills, MCP, and memory built in.
- **Claude Code** (Anthropic) — Deep integration with Claude Code CLI. Multiple permission modes for safe autonomous coding, adjustable thinking levels, and rich UI for subagent, question tools, and slash commands. Switch models and modes mid-conversation for a CLI-like experience.
- **Codex** (OpenAI) — Built on Codex App Server with full session management. Plan mode for reviewing changes before execution, rich subagent UI rendering, and sandbox isolation for safe coding. Uses the same Codex Desktop integration, giving you 2x API quota. Supports **Goal** mode (see below).
- **Gemini CLI** (Google) — Built from Gemini Core source code, fully compatible with all Gemini CLI capabilities. OAuth authentication, and rich UI rendering for subagent and all tool invocations.
- **GitHub Copilot** (GitHub) — Built on the Copilot SDK. Three modes — Interactive (per-action approval), Plan, and Autopilot (autonomous) — with configurable reasoning effort and a live, plan-specific model list.
- **Grok** (xAI) — Connected over **ACP** (see below). Four modes — Default, Plan, Auto, and Full Access — with a live model list, per-turn token accounting, and skills picked up from the shared `skills` conventions.
- **Cursor** (Cursor) — Connected over **ACP**. Agent, Plan, and Ask modes, plus a live model list (Composer, Codex, Opus, and more) pulled from your account.
- **OpenCode** (Open Source) — Built on OpenCode SDK with full feature parity. Multi-provider support for GLM, DeepSeek, and more, with rich UI rendering for all tool invocations.
- **Kimi Code** (Moonshot) — Connected over **ACP**. Four modes — Default, Plan, Auto, and YOLO (auto-approves everything) — plus slash commands like `/compact`.

When you send a message, it streams to the backend via Server-Sent Events (SSE), which routes it to the selected agent. The agent calls the AI model and streams the response back in real-time. The system maintains sessions per chat — the AI retains context across messages within the same conversation.

### ACP agents

Grok, Cursor, and Kimi Code all speak the **Agent Client Protocol** (ACP) — the open, agent-agnostic JSON-RPC protocol originally from Zed. Operon runs each CLI in its ACP mode (`grok agent stdio`, `cursor-agent acp`, `kimi acp`) and talks to it over one shared client layer, so all three get the same treatment: streaming output and thinking, tool calls with permission prompts, mode and model switching, session resume, MCP servers, and the `/` command menu.

The practical upshot is that these agents don't need bespoke integration work. Anything that ships an ACP endpoint can be wired up the same way, and each provider only has to describe what makes it different — its modes, how it advertises models, and how it reports token usage.

## Features

### Multi-Agent Support

Switch between different AI agents and models within the same interface. Each agent may offer different models, operating modes, and capabilities.

### Streaming Responses

AI responses stream in real-time as they are generated, giving immediate feedback.

### Tool Execution & Permissions

AI models can use tools (read files, write files, run commands, etc.). When a tool requires approval, a permission dialog appears. You can approve once, approve always for that tool type, or deny.

Operating modes control the default permission level:
- Restrictive modes require approval for most actions.
- Permissive modes auto-approve safe operations.

### File Attachments

Attach files to your messages using the attachment button. Text files are included as context for the AI.

### @Mention File References

Type `@` in the input to search and reference files from your workspace. The AI receives the file content as context.

### Message Injection

Some agents support injecting messages into an active session, useful for providing additional context mid-conversation.

### Session Resume

Conversations can be resumed across sessions. The system tracks session state so you can continue where you left off.

### Checkpointing & Rewind

For supported agents, the system captures file snapshots before each message. You can rewind to any previous checkpoint to undo changes the AI made to your files.

### Commands

Type `/` in the input to access agent-specific commands:
- `/compact` — compress the conversation to save context space.

Available commands vary by agent.

### Thinking Levels

Some agents support configurable thinking effort (low, medium, high). This controls how much reasoning the AI applies before responding.

### Goal Mode

Codex supports **Goal** mode: instead of a single back-and-forth turn, you give the agent an objective and it pursues it autonomously across multiple turns until the goal is reached. A goal banner above the input shows the live status (active, paused, or stopped on a usage/budget limit), the objective, and how much time and how many tokens have been spent. You can pause, resume, or clear a goal at any time.
