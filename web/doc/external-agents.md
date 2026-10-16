# External Agents

## What is it

External Agents let a primary agent delegate work to another configured agent in a separate workspace conversation. You can inspect that conversation, answer its questions, and continue it later.

## How it works

1. You choose the agent and model. If you have not specified them, the primary agent asks before starting.
2. A child conversation is created and the delegated prompt starts running.
3. Results return to the parent conversation so it can continue.
4. The primary agent can send follow-ups to the same conversation or stop its current turn.

Delegation from a workspace chat uses that workspace. [Assistant](assistant) can choose among your workspaces and create one with a separate branch when needed. Agents sharing a workspace share its files, so use separate workspaces for changes that would conflict.

## Supported Agent Types

Available configured agents include:

- **Operon** — models from your configured AI Providers.
- **Claude Code** — Claude Code CLI.
- **Codex** — OpenAI's coding agent.
- **Antigravity** — Google's ACP agent.
- **GitHub Copilot** — GitHub's coding agent.
- **Grok** — xAI's ACP agent.
- **Cursor** — Cursor's ACP agent.
- **OpenCode** — multi-provider coding agent.
- **Kimi Code** — Moonshot's ACP agent.

Models and reasoning levels follow each agent's current catalog. See [Chat](chat) for available modes; delegated sessions can use different defaults from a manually opened chat.

## Natural Language Orchestration

Describe the handoffs directly, for example:

> Use Codex to prepare a plan, then Claude Code to implement it, and OpenCode to review the changes. Ask me to choose the models first.

Follow-up work can continue the original agent conversation, keeping its context. When an agent needs a decision or approval, answer the request yourself; the parent agent does not approve on your behalf.

## Use Cases

- **Code review** — one agent writes and another reviews.
- **Parallel work** — split independent frontend and backend changes.
- **Research and implementation** — compare approaches before making changes.
- **Verification** — have a second agent test the result.

## Monitoring

Delegation cards show progress and results and let you open the child conversation. Assistant also shows coding work in **Activity**, with its workspace and model. You can inspect tool calls, send another instruction, or stop the run from the corresponding conversation.
