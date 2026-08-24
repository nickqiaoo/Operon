# Chrome

## What is it

The Chrome integration lets an agent drive **your own Google Chrome** — your tabs, your logins, your cookies, your history. It is for work that only makes sense inside a signed-in session: a SaaS dashboard you are already authenticated to, an internal tool behind SSO, a page you have open right now.

## Setup

Two pieces have to be in place: the **extension** inside Chrome, and the **native host** that lets Chrome reach Operon.

1. Go to **Settings > Chrome** and flip the switch on. This installs the Chrome skill for your agents and registers the native host.
2. In the **Connection** section, install the Operon extension from the Chrome Web Store if it is not there yet.
3. Use **Refresh** to re-check after installing.

## How agents use your browser

Because this is *your* browser, the rules about tabs are part of the behavior, not housekeeping:

- **Agents work in tabs they open.** They do not reach into your existing tabs by default.
- **Claiming an existing tab is explicit.** To act on a page you already have open, an agent has to claim that tab first, and only when the task actually calls for that page.
- **Tabs an agent opened are ephemeral.** They close at the end of the turn, unless the agent marks the tab as something worth keeping — a document it created, a dashboard, a filled-in form.
- **Unfinished work gets handed back.** When a task needs you to take over — a login, a payment, a CAPTCHA — the agent leaves that tab open and hands it to you.
- **History is treated as sensitive.** Agents read it only when the task asked for it.

## Confirmations

Anything an agent does here is done **as you**, from your signed-in session. Agents ask before:

- sending messages, posting, or submitting forms;
- purchases, payments, or anything that moves money;
- deleting data, changing permissions, or changing account settings;
- uploading files, or transmitting anything sensitive.

A request that already authorizes a specific action does not get asked twice — "reply to this email saying I'll be there" authorizes that reply, but not a different one.

## Turning it off

Flipping the switch off removes the Chrome skill from your agents and unregisters the native host. The extension stays in Chrome until you remove it yourself, but it has nothing to talk to.

## Requirements

macOS with Google Chrome installed. The extension is published on the Chrome Web Store as **Operon Browser Use**; the settings tab shows its extension ID and links straight to it.
