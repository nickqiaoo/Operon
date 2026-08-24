# Terminal

## What is it

A real shell, in a panel tab next to your chat. It starts in the current workspace directory, so you are already where the agent is working.

Open one from the **Terminal** tab in the right or bottom panel — the same panel system that hosts Files, Review, and Browser.

## Sessions survive the UI

The shell process is not tied to the tab that shows it. Closing the panel, switching tabs, or dragging a terminal from the bottom panel to the side keeps the same session running — your shell history, your running process, and your working directory all stay put.

Each workspace keeps its own set of panel tabs. Leaving a project parks its terminals; coming back restores them.

## Running a CLI agent

The **New Terminal** menu can start a terminal with a coding CLI already launched in it, rather than an empty shell:

`claude` · `codex` · `copilot` · `cursor-agent` · `gemini` · `opencode` · `kimi` · `grok`

This is the escape hatch for when you want the CLI's own interface — its slash commands, its interactive prompts, its output format — while keeping it inside Operon and inside the right repository. It is the same binary you would run yourself; if it is not on your `PATH`, the terminal reports the usual "command not found".

Providers that have no interactive CLI are not offered in this menu.

> These terminal sessions are separate from Operon's own agent conversations. A CLI running in a terminal does not share the chat's history, [memory](memory), or [MCP servers](mcp-servers) — it is that tool, running as itself.
