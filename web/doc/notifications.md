# Notifications

Operon tells you about finished and blocked work in two places: an **Inbox** inside the app, and **system notifications** from macOS.

## Inbox

Agents run in the background, across workspaces, often in tabs you are not looking at. The Inbox is the one place that collects what happened while you were elsewhere.

Open it from the **bell** in the top bar. The badge counts items that are waiting on you — completed work is listed but does not turn the badge red.

### What lands there

| Kind | When |
| --- | --- |
| **Response complete** | An agent finished a turn in a workspace chat |
| **Ready for review** | A dispatched task moved to `in_review` and needs your sign-off |
| **Done** | A task finished |
| **Failed** | A task failed or was cancelled |

Filter with **Needs you** to see only the things that are blocked on you, or **Done** for the completion notices.

### One row per source

The Inbox is a status list, not an event log. Each chat or task occupies exactly one row that reflects its current state. If the same conversation finishes again, its existing row updates and goes unread again instead of stacking up a second entry — so a long session does not flood the panel.

Clicking a row marks it read and jumps to the source: a chat opens in its workspace, a task opens its detail view. **Mark all read** clears the badge in one go.

When there is nothing outstanding, the panel says you are all caught up.

### Why it is server-side

Completion is recorded on the server, not in the browser tab. A chat tab that is not streaming gets unmounted, and the app may not even be running when a background task finishes — so the event has to survive without a live tab to catch it. This is also why the Inbox is consistent across the desktop app, the [mobile](mobile) client, and [Remote Web Access](remote-access): they all read the same records.

## System notifications

The Inbox is for when you come back. System notifications are for when you are in another app.

Go to **Settings > Notifications**:

- **Show system notifications when the window is not focused** — the master switch. Nothing is sent while you are actively looking at Operon.
- **Notify on Response Complete** — an agent finished its response.
- **Notify on Approval Required** — a tool is waiting for your permission.

Approval requests are the case worth leaving on: an agent that needs permission is stopped until you answer, and without a notification it can sit there for a long time.

macOS decides how these are displayed. If nothing appears, check Operon's entry in **System Settings > Notifications**.
