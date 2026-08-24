# Browser

## What is it

Operon ships a built-in web browser as a panel tab, so you can preview a running app right next to your chat without leaving the window. On top of plain browsing it adds **page annotations**: switch into comment mode, click elements on the page, write notes, and send those notes straight to an agent as actionable context — ideal for "fix this button" / "tighten this spacing" style feedback on your own dev server.

The same browser can be driven by agents. With **Browser Use** on, an agent opens pages, clicks, types, and reads what it sees — so it can check its own work against a running app instead of guessing. See [Agent automation](#agent-automation) below.

## Opening a browser

Open a **Browser** tab in the right or bottom panel (the same panel system that hosts Files, Review, and Terminal). Each workspace remembers its own open tabs.

When a new browser tab has no URL yet, it shows a **local servers** landing page instead of a blank page — a list of the localhost ports you've recently visited, so you can jump back to `localhost:3000` and similar dev servers in one click.

## Navigation

The address bar handles smart input:

- A full URL (`https://…`) is loaded as-is.
- Text with spaces becomes a Google search.
- A bare domain gets `https://` prepended.

Back / forward / reload (which becomes a stop button while loading), a screenshot button that copies the page to your clipboard, and a three-dot menu round out the chrome. The menu also offers force reload, the device toolbar toggle, zoom controls, and clearing cookies or cache.

## Device simulation

Toggle the **device toolbar** to constrain the page to a fixed mobile or tablet viewport, so you can check responsive layouts without resizing the window.

## Page annotations

This is the part built for working with agents.

1. Turn on **comment mode** from the address bar.
2. Click any element on the page. Operon drops a pin, captures the element, and measures its styles.
3. Write a comment for that element in the editor that pops up.
4. Repeat for as many elements as you like — each gets its own pin.

When you're done, the address bar shows a **Send N** button. Sending hands all your annotations to the chat as structured context, so the agent knows exactly which elements you mean and what you want changed. A **before/after** toggle lets you preview design changes, and a trash button clears the current tab's annotations.

Annotations also appear in a tray on the chat side, so you can review and manage them before sending.

## Agent automation

Annotations are how *you* point at a page. Browser Use is how an **agent** works one on its own.

Turn it on at **Settings > Browser Use**. That installs the Browser skill for your agents; turning it off removes it, and agents can no longer see the browser at all.

Once on, an agent can:

- open and navigate pages, including your `localhost` dev server;
- read the page structure to find elements, rather than guessing at coordinates;
- click, type, fill forms, and upload files;
- take screenshots when it needs to see the result.

This is the browser to use for work that does **not** need your identity — verifying a local app, reading a public page, throwaway navigation. It has its own profile and cannot touch your real browser's session. When a task genuinely needs your logins and cookies, agents use the [Chrome integration](chrome) instead.

### Site approvals

An agent asks before opening a site for the first time. You can allow it for that conversation only, or for all conversations.

**Settings > Browser Use** lists what stuck:

- **Approved sites** — sites allowed in every conversation. Revoke one and the agent has to ask again next time it goes there.
- **Approvals remembered from past conversations** — shown as a count, with one button to clear them all. Individual per-conversation approvals are not listed because they die with their conversation.

Approvals survive turning Browser Use off and on again; they are stored on disk at `~/.operon/browser/`.

### Full CDP access

Off by default. It lets agents send raw Chrome DevTools Protocol commands instead of only the high-level browser actions. It is powerful, hard to audit, and rarely needed — leave it off unless something specifically requires it.
