---
name: operon-external-agent
description: Delegate work to an external coding agent in an Operon chat tab, follow up in the same conversation, inspect its result, or stop it. Use when the user asks another agent to handle a task. For JavaScript workflow orchestration, use operon-workflow instead.
---

<!-- OPERON_MANAGED_EXTERNAL_AGENT_SKILL -->

# Operon External Agent

External agents run on the Operon server in ordinary, independent chat sessions.
Their tabs show live text and tool calls. Closing a tab does not stop the work.

## Choose the agent and model

Before creating a child, call `external_agent_list_models` for the available agents
and their current model choices. Use `agentTypes` to limit it to an agent the user
already named. Long catalogs return groups; use `query` to narrow the list.

Ask the user to choose both an agent and a model. Preserve explicit choices already
provided in this conversation; only ask for the missing choice. Never silently
choose a model. `model: 'default'` is valid when the user accepts that agent's own
configured model. Do not embed a static model list in prompts.

Then call `external_agent_run` with `agent_type`, `model`, `prompt`, `description`,
and `selection_confirmed: true`. Set the confirmation flag only after the user's
choices are known. The initial prompt must include the goal, constraints, and
necessary context: the child does not see the parent conversation.

## Continue the same child

Keep the returned `agent_id`. Send subsequent instructions with
`external_agent_send({ agent_id, prompt })`, which retains the child's history and
model. Do not create a replacement agent just to continue the conversation. No
new model question is needed for follow-ups using the same configuration.

The run and send tools return immediately with a `turn_id`. This acknowledges
acceptance, not completion. Results return automatically to this conversation.
Results arriving together may be combined. While the parent is running, supported
agents receive them as follow-up input; otherwise they arrive together in a new
turn once the parent is idle.
If later work depends on the result, end your current turn with a brief update
and wait. Continue independent work when useful. Do not sleep or repeatedly poll.
Use `external_agent_status` for an explicit status request or to retrieve a result.

## Questions for the user

A child may need something from the user. It asks in its own tab, and the user
answers there. If a result reaches you asking the user a question, tell the user
what it asked and that they can reply in the agent's tab, then end your turn.
Never answer on the user's behalf, and never `external_agent_send` a reply the
user did not give you.

## User intervention and stopping

The user can stop a turn in the child tab and send a new prompt there. The new
turn still belongs to this child, and its result returns to the parent. Read the
reported prompt source and status: a result may reflect instructions the user
updated directly in that tab.

`external_agent_stop({ agent_id })` stops the current turn and cancels queued
messages; the conversation remains available for follow-up. Cancellation is not
success. Do not automatically restart a turn the user stopped.

Execution queues and pending result delivery live in server memory. A server
restart preserves chat history and parent-child relationships, but does not
restart interrupted work or automatically resend pending results. Continue an
interrupted child only when the user requests it.
