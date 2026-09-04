---
name: operon-chrome
description: Drive the user's own Google Chrome through the Operon extension — open and navigate tabs, inspect pages, claim tabs the user already has open, and search their history. Use this instead of a Codex or ChatGPT Chrome skill when the agent is running inside Operon. Prefer operon-browser-use for throwaway work that does not need the user's real browser.
---

<!-- OPERON_MANAGED_CHROME_SKILL -->

# Operon Chrome

Drives the user's real Chrome, with their real logins, cookies and history.

Use this skill when the task needs *that* browser: a site the user is already signed in to, a
page they have open, or their browsing history. For anything else — checking a localhost app,
scraping a public page, throwaway navigation — prefer the `operon-browser-use` skill, which
drives Operon's own in-app browser and cannot touch the user's session.

## Connect

Run all setup and browser API calls through the `node_repl` MCP `js` tool. Its visible name
may be namespaced, such as `mcp__node_repl__js`. Do not replace this path with standalone
Playwright, shell-launched browsers, or Computer Use.

`agent` is already installed in every `node_repl` session before your first line of code runs. Do not import the browser client or write a setup guard; if `agent` is somehow missing, the first tool result of the session says why.

Bind Chrome once, then print and read its complete documentation before the first interaction:

```js
if (globalThis.chrome == null) {
  globalThis.chrome = await agent.browsers.get("extension");
  nodeRepl.write(await chrome.documentation());
}
```

Before trying to interact with Chrome for the first time, you MUST emit and read the complete
documentation returned by `chrome.documentation()` in one go. For the initial documentation
read, run the exact direct `nodeRepl.write(await chrome.documentation());` call shown above.
Do not assign the documentation to a variable, inspect its length, slice it, truncate it,
summarize it, or emit only an excerpt. Do not proactively split the documentation into pages
or chunks. Only if the tool output itself explicitly reports that it was truncated may you
emit and read smaller chunks until you have read the documentation in its entirety.

Use `"extension"` when explicitly selecting Chrome. `"chrome"` remains a compatibility alias,
but it is not the current browser-client contract used by this skill.

Once the browser connection is established, reuse `globalThis.chrome` across later turns and
do not reread this skill. Once you have read Chrome's complete documentation, do not read it
again unless you select a different browser. A new user turn does not invalidate the browser
binding or require another selection or documentation call.

A tab binding is separate from the browser binding. If a tab is missing, stale, closed, or no
longer part of the current browser session, discard only that tab binding and obtain or create
a fresh tab from `globalThis.chrome`. An empty tab list is normal after cleanup. Only an
explicit browser-disconnected error invalidates the browser binding.

If binding fails, Chrome is not reachable: the extension may not be installed or enabled, or
Chrome may not be running. Read `await agent.documentation.get("chrome-troubleshooting")`
before retrying. Do not fall back to AppleScript, shell commands, or any other way of driving
the browser, and do not try to install or repair anything — Operon manages the extension and
the native host from Settings › Chrome.

## Operate

Follow the browser's own documentation exactly, and use its tab, Playwright and screenshot
APIs rather than guessing method names.

This is the user's browser, so the rules about their tabs are not housekeeping:

- **Their tabs are theirs.** Work in tabs you created. To act on a tab the user already has
  open, claim it first, and only when the task actually calls for that page.
- **Clean up what you opened.** Tabs you create are ephemeral and close when the turn ends
  unless you mark them. Mark a tab as a deliverable when the page itself is the output the
  user wanted left open — a document you created, a dashboard, a filled-in form. Mark it as a
  handoff only when the work is unfinished and it must continue from that live page, such as
  a login, a payment, or a CAPTCHA. Marks last one turn: mark again next turn if it must
  survive again.
- **Do not mark research, search, source, intermediate, duplicate, blank or error tabs.** Once
  you have taken what you need, let them close.
- **History is sensitive.** Read it only when the task asked for it, and do not repeat its
  contents beyond what answers the question.

## Confirm

Ask for confirmation immediately before any consequential action, and wait for an answer —
this browser is signed in as the user, so an action here is an action taken *as them*:

- sending messages, posting, or submitting forms;
- purchases, payments, or anything that moves money;
- deleting data, changing permissions, or changing account settings;
- uploading files, or transmitting anything sensitive.

The exception is when the user's request already authorizes that specific action. "Reply to
this email saying I'll be there" authorizes that reply, not a different one.
