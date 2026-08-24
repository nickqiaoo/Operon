# Channels

## What is it

A channel is a project-scoped, Slack-like collaboration space built into Operon. Each project can have multiple channels, and each channel keeps its own member list, message history, threads, and tasks. Agents and human members share the same channel and can collaborate around an ongoing topic, instead of starting a fresh ad-hoc chat each time.

Channels and the default Workspace Chat (the Chat tab under each Workspace) are two independent threads of conversation:

- **Workspace Chat** — your one-on-one session with a single agent, organized per conversation.
- **Channel** — a multi-agent, multi-person shared space scoped to a project, organized by topic, with thread and task support.

## Opening channels

1. Pick a Workspace from the sidebar.
2. Click the **Channels** entry in the workspace header (`MessageSquare` icon) to enter that project's channels page.
3. The **ChannelSidebar** on the left lists all channels; clicking one opens the chat view on the right.

Channel data is scoped by `projectId` — switching Workspace switches you to the channels under that project.

## Creating a channel

In the channel sidebar click **New channel**:

- **Name** — channel name (unique within the project).
- **Description** — short description so members know what the channel is for.

A new channel is empty — you'll need to add members before any conversation happens.

## Members

The channel header's **Manage members** dialog lets you:

- **Add Agent** — add an existing agent from this project to the channel. Once added, the agent subscribes to channel messages and responds to `@`-mentions according to its permission mode.
- **Remove** — remove a member; history is preserved, but they no longer receive new messages.

Channel members are agents only. You don't "join" as a human — opening any channel inside the Operon desktop is enough to chat; your messages are recorded with sender type `human`.

### Creating and editing agents

"Add Agent" adds an agent that already exists. Agents themselves are created in the **Manage Agents** dialog, reachable either from the channel or from **Settings > Agents** when you'd rather not open a channel first. Both routes open the same dialog.

An agent is defined by:

| Field | What it does |
| --- | --- |
| **Name** | How it's addressed — this is what you `@`-mention |
| **Adapter** | Which [provider](providers) backs it |
| **Model** | The model that provider should use |
| **Instructions** | Its persona and standing instructions |
| **Permission Mode** | How much it can do without asking |
| **Environment Variables** | Per-agent overrides for the runtime environment |

The same agents are what IM bots embody in `mate` mode — see [IM Platforms](im-platforms).

## Messages and threads

- Top-level messages display newest-first. Click any message to open the **ThreadPanel** — replies inside a thread don't flood the main view, making sub-topics easy to track.
- Each message is tagged with a sender type: `human`, `agent`, or `system` (system notifications like member join / task status changes).
- `@`-mentioning an agent triggers it to handle that message individually. Without an `@`, agents stay silent by default — this prevents multiple agents from talking over each other.

## Tasks view

From the channel sidebar you can switch from **Chat** to the project's **Tasks** view — a full task board (List / Board / Teams) scoped to the current project. Channel discussions are where work is decided; tasks are the durable, trackable items that come out of them. A task can be created directly, spun up by an agent that splits its work into steps, or — in SDD-enabled channels — promoted from a converged discussion into a structured change package.

Tasks carry status, priority, assignee, and an activity feed, and can be dispatched to an agent that runs them on an isolated git branch. See [Tasks](tasks) for the full board, and [Spec-Driven Development](sdd) for the gated spec → plan → acceptance flow.

## One agent in many channels

The same agent can be a member of multiple channels, each with its own session context (channels do not share history). You can have a single "review-bot" agent live in both `#frontend` and `#backend`, with reviews from one channel never bleeding into the other.

## How it differs from other chat surfaces

- **Channel vs Workspace Chat** — A channel is shared space; Workspace Chat is solo. Use channels for ongoing topics, Workspace Chat for one-off tasks.
- **Channel vs IM Platforms** — IM Providers bridge agents to external Slack / Telegram / Discord platforms; the agent responds in those external platforms' channels and never appears in Operon's internal channel list. The two are independent collaboration surfaces and do not share state. See [IM Platforms](im-platforms).
- **Channel vs External Agents** — External Agents are sub-task delegation inside a Workspace Chat — cross-agent, but still a one-on-one conversation. Channels are open multi-party / multi-agent spaces.

## Troubleshooting

- **Agent doesn't respond in the channel** — Make sure the agent is in the channel's member list, and that you `@`-mentioned it.
- **Tasks view is empty** — Create a task with the **New** button, or let an agent split its work into steps. See [Tasks](tasks).
