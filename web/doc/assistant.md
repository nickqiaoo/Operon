# Assistant

## What is it

Assistant is a personal assistant that sits above your workspaces. Keep one ongoing conversation for everyday requests, follow-ups, and coordinating project work, without choosing a repository first.

Open **Assistant** from the left sidebar. On a phone, use the **Assistant** tab. Your conversation, activities, and settings belong to the connected desktop.

## Getting started

1. Open **Settings > Assistant** and choose an agent and model for **Conversation**, **Work**, and **Background checks**.
2. Choose from **Operon**, **Claude Code**, **Codex**, and **OpenCode**. CLI agents need their own login; Operon needs a configured [AI Provider](providers). Work on a CLI agent counts toward its subscription limits.
3. Return to Assistant and introduce yourself. You can choose its name and how it addresses you.

Conversation handles the dialogue; Work handles general tasks such as research, files, and apps. Background checks runs the heartbeat and scheduled tasks, and can use **Same as Work**. Changing Conversation takes effect on your next message; continuing an existing task keeps its original agent.

## Tasks and activity

Ask for something in plain language. Assistant can hand off work while you keep talking, then bring the result back to the conversation.

The **Activity** panel shows what is running, waiting, or finished. Open an activity to see its steps and result, send a follow-up, or stop it. General tasks can use connected plugins and the browser or Mac apps when those capabilities are enabled on the desktop.

## Coordinating project work

Ask which workspaces have running conversations, what is waiting for you, or what is on a project's task board. Assistant can:

- Start a coding agent in a selected workspace, then report its result. You choose the agent and model; if they are not specified or remembered, it asks first.
- Continue or stop coding conversations it started. Each is an ordinary workspace chat you can open and take over.
- Create a workspace with its own branch when isolation is needed, or add a local repository or clone a project.
- Create, update, and comment on board tasks when asked.
- Read GitHub pull requests, reviews, and checks, or create a pull request when requested, using your local `gh` login.

Coding cards show the workspace, agent, model, and current state. Questions and approvals can be answered on the card, or you can use **Open conversation** to handle them there. Assistant does not answer on your behalf.

Assistant activities and board tasks are separate: starting a coding conversation does not automatically link it to a board task or pull request.

## Memory and profile

Assistant keeps selected facts, preferences, and ongoing matters in its own **Memory**, with daily notes for details. It carries this context into fresh sessions so the visible conversation can continue over time.

Use **Profile** to review or edit **Soul** (tone and character) and **Memory**. Use the edit button by its name to change **Identity**. You can also ask it to remember or forget something. These notes reflect its understanding; correct anything that is wrong or out of date.

Assistant's profile memory is separate from the searchable [Memory](memory) library used across agent conversations. It can search that library for older context when available.

## Heartbeat and schedules

The **Schedule** panel contains Assistant's own jobs, separate from the sidebar's [Schedule](cronjob) page.

- **Heartbeat** — checks every 30 minutes, following its checklist and ongoing matters in memory. Ask Assistant to watch something, or use **Edit checklist** to specify the checks. With nothing to check, it skips the run; it speaks up when it finds something worth reporting.
- **Scheduled tasks** — ask for a recurring job, such as a daily briefing. Review its next run and recent results, pause or resume it, delete it, or use **Run now**.

The heartbeat's checklist keeps an **Already told** record to avoid repeating ongoing findings. Unavailable checks are recorded as incomplete. Plugins that need sign-in are shown on the heartbeat card; connect them from **Plugins** on the desktop.

Set **Quiet hours** in **Settings > Assistant** (23:00–08:00 by default). The heartbeat only speaks up for urgent findings during those hours; other findings wait. Keep the desktop running for background work.

## Approvals and audit

General tasks that need permission show **Allow once** and **Deny** cards. Background checks and scheduled tasks skip steps that still require a person, and report the limitation.

The **Audit** panel records actions and approval decisions. For broader project notifications and work waiting on you, see [Notifications](notifications).
