# Chat

## What is it

Chat provides a streaming conversation with AI agents, with tool execution, file operations, permission controls, and session history. For a continuous personal conversation across projects, see [Assistant](assistant).

## How it works

Choose an agent and model above the input. Operon currently integrates nine agents:

- **Operon** — the built-in agent, with [AI Providers](providers), tools, skills, MCP, and memory. Its permission modes are Manual, Workspace, Auto, and YOLO.
- **Claude Code** — Default, Auto, Accept Edits, Plan, Bypass, and Don't Ask modes, with model-dependent thinking controls.
- **Codex** — Request Approval, Approve for Me, Full Access, and Plan modes, plus sandboxed execution and Goal mode.
- **Antigravity** — Google's agent over ACP, with Default, Auto Edit, and YOLO modes. Install its server and check sign-in in **Settings > Antigravity**.
- **GitHub Copilot** — Normal, Plan, and Autopilot modes, with account-specific models and reasoning controls.
- **Grok** — ACP integration with Default, Plan, Auto, and Full Access modes.
- **Cursor** — ACP integration with Agent, Plan, and Ask modes.
- **OpenCode** — multi-provider agent with Build, Plan, and Full Access modes.
- **Kimi Code** — ACP integration with Default, Plan, Auto, and YOLO modes.

Model lists and available controls depend on the agent, installed version, and account. Each chat keeps its own session context across messages.

### ACP agents

Antigravity, Grok, Cursor, and Kimi Code use the **Agent Client Protocol** (ACP). Operon presents their streamed replies, tool calls, permission prompts, model and mode controls, session history, and available commands in the same chat interface. The controls shown depend on what each agent supports.

## Features

### Multi-Agent Support

Choose different agents and models for different conversations. Use [External Agents](external-agents) when you want one agent to delegate work to another.

### Streaming Responses

AI responses stream in real time as they are generated.

### Tool Execution & Permissions

Agents can read files, edit code, and run commands. When approval is required, the chat shows the request; the available choices depend on the agent and tool. Pending requests also appear in the [Inbox](notifications).

Operating modes set the default behavior:

- **Manual / Default / Request Approval / Normal** ask when the agent needs permission.
- **Workspace / Accept Edits / Auto Edit** allow specified edits while keeping other checks.
- **Auto / Approve for Me** let the agent review actions and escalate when needed.
- **Plan / Ask** focus on planning or questions, with restrictions specific to the agent.
- **Bypass / Full Access / YOLO / Autopilot** remove approval prompts according to that agent's mode. Choose them deliberately.

### File Attachments

Attach files using the attachment button. Text files provide context; supported agents can also receive images.

### @Mention File References

Type `@` to search and reference workspace files. Their content is provided to the agent.

### Message Injection

Supported agents accept follow-up messages while a turn is running. Other agents queue them until the current turn finishes.

### Session Resume

Open an existing conversation to continue from its saved session history.

### Checkpointing & Rewind

Operon captures workspace checkpoints for chat turns. Use rewind to inspect and restore changes from a previous turn; review the affected files before confirming.

### Commands

Type `/` to see available commands, including `/compact` where supported. The list varies by agent and can include skills.

### Thinking Levels

Supported agents and models offer reasoning-effort controls. Available levels vary by model.

### Goal Mode

Codex supports **Goal** mode: give it an objective to pursue across turns. The goal banner shows its status, objective, elapsed time, and token use. You can pause, resume, or clear a goal; usage or budget limits can stop it.
