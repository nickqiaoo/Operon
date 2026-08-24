---
name: operon-browser-use
description: Control the Operon in-app Browser to open, navigate, inspect, click, type, capture screenshots, and test web pages, including localhost. Use this instead of a Codex or ChatGPT browser skill when the agent is running inside Operon.
---

<!-- OPERON_MANAGED_BROWSER_SKILL -->

# Operon Browser

Use this skill when the user explicitly asks to operate the in-app browser or when a local web application needs interactive verification. For semantic work on a linked service, prefer a dedicated connector or API when one is available.

## Setup documentation

Read `await agent.documentation.get("<name>")` only when one of these topics applies:

- `bootstrap-troubleshooting`: runtime setup succeeds but discovery or selection fails
- `browser-troubleshooting`: the selected in-app browser disconnects or rejects an operation
- `file-uploads`: the task needs to upload a file

## Connect

Run all browser setup and browser API calls through the `node_repl` MCP `js` tool. Its visible name may be namespaced, such as `mcp__node_repl__js`. Do not replace this path with standalone Playwright, shell-launched browsers, or Computer Use.

Initialize the runtime once per fresh JavaScript session:

```js
if (globalThis.agent?.browsers == null) {
  const clientPath = nodeRepl.env?.OPERON_BROWSER_CLIENT_PATH;
  if (typeof clientPath !== "string" || clientPath.length === 0) {
    throw new Error("Operon Browser client is unavailable");
  }
  const { setupBrowserRuntime } = await import(clientPath);
  await setupBrowserRuntime({ globals: globalThis });
}
```

Bind the in-app browser once, then print and read its complete documentation before the first interaction:

```js
if (globalThis.iab == null) {
  globalThis.iab = await agent.browsers.get("iab");
  nodeRepl.write(await iab.documentation());
}
```

Before trying to interact with the in-app browser for the first time, you MUST emit and read
the complete documentation returned by `iab.documentation()` in one go. For the initial
documentation read, run the exact direct `nodeRepl.write(await iab.documentation());` call
shown above. Do not assign the documentation to a variable, inspect its length, slice it,
truncate it, summarize it, or emit only an excerpt. Do not proactively split the
documentation into pages or chunks. Only if the tool output itself explicitly reports that it
was truncated may you emit and read smaller chunks until you have read the documentation in
its entirety.

Once the browser connection is established, reuse `globalThis.iab` across later turns and do
not reread this skill. Once you have read the browser's complete documentation, do not read it
again unless you select a different browser. A new user turn does not invalidate the browser
binding or require another selection or documentation call.

A tab binding is separate from the browser binding; if a tab was closed or became stale,
obtain or create another tab without rebuilding the browser runtime.

An empty `iab.tabs.list()` or `iab.user.openTabs()` result is normal after tab cleanup and does not invalidate the browser binding. Never call `agent.browsers.get*` merely to recover a tab. Only an explicit browser-disconnected error invalidates `globalThis.iab`; reconnect it once, then obtain a fresh tab.

If discovery or selection fails after setup, read `bootstrap-troubleshooting` before resetting the JavaScript session or trying another browser-control mechanism.

## Operate

Follow the selected browser's documentation exactly. Use its tab, Playwright, and screenshot APIs rather than guessing method names. Preserve existing user tabs unless the task explicitly asks to modify them, and finalize agent-created tabs when the task is complete.

Ask for confirmation immediately before consequential external actions such as sending messages, submitting forms, purchases, deleting data, changing permissions, uploading files, or transmitting sensitive information unless the user's request already provides valid approval for that specific action.
