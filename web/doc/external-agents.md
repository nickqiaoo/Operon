# External Agents

## What is it

External Agents let your primary AI delegate tasks to other AI agents. When a task is too specialized or would benefit from a different model, the main agent can spawn a sub-task that runs in a separate chat tab with a different provider.

## How it works

During a conversation, the primary agent can decide that a subtask should be handled by a different agent. When this happens:

1. A new chat tab opens automatically in the background.
2. The external agent receives the delegated prompt and begins working.
3. When the external agent finishes, its result is sent back to the parent conversation.
4. The parent agent incorporates the result and continues.

This all happens within the same workspace — you can watch both conversations in real-time by switching tabs.

## Supported Agent Types

Any configured adapter can serve as an external agent:

- **Claude Code** — Deep code understanding with file checkpointing.
- **Codex** — Sandboxed code execution with OpenAI models.
- **Gemini CLI** — Google's Gemini models with thinking budgets.
- **GitHub Copilot** — Interactive, Plan, and Autopilot modes with configurable reasoning effort.
- **Cursor** — The `cursor-agent` CLI with Plan, Ask, and Agent modes.
- **Kimi Code** — Moonshot's Kimi model with Plan and Full Access modes.
- **OpenCode** — Open-source models via dynamic provider discovery.
- **Custom** — Any model from your configured providers.

## Natural Language Orchestration

You can describe multi-agent collaboration workflows in natural language directly in the conversation, and the primary agent will automatically orchestrate task delegation. For example:

> Use Codex with GPT-5.4 model to create an implementation plan, then execute the plan, and finally use Gemini 3.1 Pro model to review the code

The primary agent will sequentially delegate "create plan" to Codex, execute the plan, then delegate "code review" to Gemini — all automatically.

## Use Cases

- **Code review**: Have one agent write code while another reviews it.
- **Multi-language tasks**: Delegate frontend work to one agent and backend work to another.
- **Research + implementation**: One agent researches an approach, another implements it.
- **Verification**: Have a second agent verify or test the output of the first.
- **Cross-model collaboration**: Leverage different models' strengths — e.g., one model for planning, another for execution.

## Monitoring

Each external agent task runs in its own tab with full visibility. You can see the prompt, the agent's tool calls, and the final result. The parent tab shows a summary of what was delegated and what came back.
