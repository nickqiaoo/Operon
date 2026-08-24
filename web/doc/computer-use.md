# Computer Use

## What is it

Computer Use lets an agent operate **native Mac apps** — read what is on screen, then click, type, scroll, and press keys in it. It is for work that has no API, no CLI, and no MCP server: a desktop mail client, a design tool, a legacy internal app, a settings panel.

Clicks are delivered to the target window directly, so an agent can drive an app sitting in the background while you keep working in another window.

It runs on the Mac itself, so it is the one feature that does not follow you to the web build or to mobile — those can watch a conversation that uses it, but cannot start one.

## Turning it on

1. Go to **Settings > Computer Use**.
2. Flip the switch on.

Turning it on installs the Computer Use skill for your agents and starts the native engine. Turning it off removes the skill and stops the engine — agents can then no longer see or operate your apps.

## System permissions

macOS grants these to the native engine, not to Operon's main window. The settings tab lists both with a live status and a button that opens the right pane of System Settings.

| Permission | Needed for |
| --- | --- |
| **Accessibility** | Reading app interfaces, and sending clicks and keystrokes |
| **Screen & System Audio Recording** | App screenshots and the live preview window |

Without Screen Recording there is no preview and no screenshots — accessibility text still works, so an agent may appear to be running blind rather than failing outright.

> Rebuilding, moving, or replacing the app can silently revoke a grant. If Computer Use suddenly stops seeing an app, re-check this tab before debugging anything else.

## How an agent sees an app

The agent does not work from pixels by default. It reads the app's **accessibility tree** — a text description of every window, control, and label, where each element carries an index.

- Actions target an element by that index, not by coordinates, which is far more reliable than clicking a position.
- After each action the agent re-reads the state, because indexes are re-derived every time.
- Repeat reads return a **diff** of the tree — only what was added, removed, or changed — so long sessions stay cheap.
- Screenshots are a fallback for when the accessibility tree is incomplete, which happens with canvas-heavy or custom-drawn UI.

An app can be named by display name (`Google Chrome`), full path, or bundle identifier (`com.google.Chrome`). If the app is not running, reading its state launches it in the background.

## What an agent can do

| Action | What it does |
| --- | --- |
| `click` | Click an element, or a coordinate; supports right/middle button and double clicks |
| `type_text` / `set_value` | Type into the focused element, or set a field's value directly |
| `press_key` | Press a key or combination, including modifiers and navigation keys |
| `scroll` | Scroll an element up, down, left, or right by pages |
| `drag` | Drag between two coordinates |
| `select_text` | Select text inside an editable element, or place the cursor around it |
| `perform_secondary_action` | Invoke an accessibility action the element exposes — expand a row, show a menu, cancel |

Key presses and typing are delivered to the target app, so they cannot trigger global system shortcuts.

## Live preview

While an agent is operating an app, Operon shows a native **live preview** window next to the conversation, so you can watch what is happening in real time without switching to the app yourself. The preview is independent of screenshots — the agent does not need to capture anything to keep it running.

## Approvals

Computer Use is deliberately more cautious than file edits.

- An agent asks before operating an app for the first time in a conversation.
- Actions with real consequences require confirmation at the moment they happen, even if you approved the overall task up front.
- A short list of actions is **hand-off only**: the agent stops and asks you to do it yourself. This covers entering or changing passwords, bypassing browser security warnings, and financial transactions.
- Some actions are never confirmed because they change nothing — reading, searching, listing, summarizing.

Approvals live in the conversation, not in a settings store. Nothing is remembered between conversations, and there is no allowlist of pre-approved apps to manage — which is why this settings tab has only one switch.

## When to use something else

Computer Use is the most general tool available to an agent, and also the slowest and most fragile. Prefer a purpose-built path when one exists:

- A web app you are signed in to → the [Chrome extension](chrome), which drives real browser tabs.
- A local web app or a throwaway page → the [in-app browser](browser).
- Anything with a CLI, an API, or an [MCP server](mcp-servers) → use that instead.
