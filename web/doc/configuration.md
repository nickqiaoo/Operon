# Configuration files

Most settings have a UI. This tab is for the rest — the config files that agents and CLIs actually read, edited in place instead of in a terminal.

Every editor here validates before it saves: JSON and TOML files are parsed as you type, and a syntax error is reported with its line and column rather than being written to disk.

## Operon's own config

**Settings > Custom** edits `~/.operon/config.toml`. It controls three things:

| Key | What it does |
| --- | --- |
| Permission rules | Which actions are approved automatically and which stop to ask |
| Loop control | `maxTurns` and `maxStepsPerTurn` — how long an agent may keep working before it has to come back to you |
| `pluginMarketplaces` | The GitHub repositories [plugins](plugins) are browsed and installed from |

Two things are worth knowing about how this file is read:

- **It is layered and per-workspace.** User, project, and local tiers are merged, and the result is loaded per git root — so a repository can carry its own rules without touching your global config.
- **It does not configure MCP.** MCP servers live in their own `mcp.json` family of files; see [MCP Servers](mcp-servers). This split is deliberate.
- **A broken file degrades, it does not break.** If the TOML fails to parse, Operon logs a warning and falls back to defaults rather than failing your conversation.

## CLI provider configs

The same editor opens the config files of the CLIs Operon drives, so you can adjust them without leaving the app. These are the tools' own files in their own formats — Operon only reads and writes them.

| Tab | Directory | Files |
| --- | --- | --- |
| **Claude Code** | `~/.claude` | `settings.json`, `CLAUDE.md`, `keybindings.json` |
| **Codex** | `~/.codex` | `config.toml`, `instructions.md` |
| **OpenCode** | `~/.config/opencode` | `opencode.json`, `AGENTS.md` |
| **Kimi** | `~/.kimi` | `config.toml` |
| **Grok** | `~/.grok` | `config.toml` |

The markdown files (`CLAUDE.md`, `instructions.md`, `AGENTS.md`) are global custom instructions — they apply to every project that CLI runs in, which makes them the wrong place for anything project-specific.
