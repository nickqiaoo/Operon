# Tasks

## What is it

Tasks is a project-scoped task tracker built into Operon. Instead of losing work items inside chat history, each project gets a real board where humans and agents create, assign, dispatch, and track tasks to completion. Agents can pick up a task, run it in an isolated git branch, and report progress back — all without leaving Operon.

Tasks live alongside Channels. From a project's Channels area, switch between the channel **Chat** view and the **Tasks** view from the sidebar.

## Views

The same task list can be displayed three ways:

- **List** — a dense, grouped list. Group by status, priority, assignee, or team.
- **Board** — a Kanban board with one column per status, drag-and-drop between columns.
- **Teams** — tasks organized by the team (inbox group) responsible for them.

Use the filters at the top to narrow by status, assignee, priority, or team, and toggle **Show archived** to bring completed/cancelled work back into view.

## Task anatomy

Each task carries:

- **Title & description** — what needs to happen.
- **Status** — `todo` → `in_progress` → `in_review` → `done` (or `cancelled`). Transitions are validated, so you can't skip required steps.
- **Priority** — none, low, medium, high, or urgent. Sorting by priority puts urgent first.
- **Assignee** — the agent responsible for executing it.
- **Labels & team** — group related tasks and route collaboration.
- **Branch** — when a task is dispatched, it runs on its own git branch in an isolated worktree, so parallel tasks never collide.

## Working with tasks

### Creating

Click **New** to open the task dialog. Give it a title, an optional description, priority, and assignee, then save. Agents can also create tasks on their own when they decide to split work into steps.

### Dispatching to an agent

Open a task and **dispatch** it to an agent. Operon provisions a dedicated per-task git worktree, hands the agent the task as its working context, and flips the status to `in_progress`. You can watch the execution stream in real time.

### Commenting & waking agents

The task detail view has a comment composer. Leaving a comment on a dispatched task **wakes the assigned agent** — use it to give feedback, answer a question, or nudge the work forward without starting a fresh chat. All comments, status changes, assignments, and dispatch events are recorded in the task's **Activity** feed.

### Opening the workspace

From a task you can jump straight into the workspace/worktree where the agent is doing the work, to inspect files or take over manually.

## Live updates

Task changes stream over Server-Sent Events. When an agent updates a status, leaves a comment, or another window edits a task, the board updates instantly — no refresh needed.

## Spec-Driven Development

Tasks are the execution layer underneath Operon's optional **Spec-Driven Development** workflow. When a task is promoted from an SDD-enabled channel, its detail view gains a **spec / plan / acceptance** panel with human approval gates. See [Spec-Driven Development](sdd) for the full flow.

## How it differs from other surfaces

- **Tasks vs Channel chat** — Channels are for ongoing discussion; Tasks are the durable, trackable work items that discussion produces.
