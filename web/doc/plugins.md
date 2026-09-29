# Plugins

## What is it

Plugins bundle reusable agent capabilities — **skills** and **MCP servers** — into a single installable package. Install one and everything it carries becomes available to your agents at once, without wiring each piece up by hand.

## How plugins work

A plugin follows the Codex plugin format and can carry:

- One or more **skills** — instruction packs that extend what an agent can do (see [Skills](skills)).
- One or more **MCP servers** — external tool servers the agent can call (see [MCP Servers](mcp-servers)).

Plugins are managed globally rather than per session, and changes apply to **new chat sessions**.

## Every agent gets them

A plugin is not tied to the Operon agent. Once enabled, its skills and MCP servers are available to **every agent Operon runs** — Operon, Claude Code, Codex, OpenCode, Kimi, Cursor and the others.

- **Skills** are placed in the shared skill folders (`~/.agents/skills`, plus each agent's own folder such as `~/.claude/skills`). They show up in **Settings → Skills** marked *via <plugin>*; add or remove them from the plugin, not from Skills. Because they are real folders, agents you run in a terminal see them too. If you already have a skill with the same name, yours is kept and the plugin's is skipped — the plugin page shows the conflict.
- **MCP servers** are added to each conversation Operon starts, and listed under **Settings → MCP → From plugins**. Agents you run directly in a terminal don't get them.
- **Sign in once.** An MCP server that needs you to sign in (Linear, for example) is signed in from the plugin page, once. Other agents reach it through Operon, which keeps the login — they never see the token. Until you sign in, agents see a single `connect_required` tool that tells you where to go. After you sign in, Claude Code and OpenCode conversations pick up the real tools right away; a Codex conversation that was already open needs a new conversation.

## Managing plugins

Click **Plugins** at the bottom of the left sidebar. There are two sections.

### Marketplace

Browse and install plugins from the registries you configure. Click **Browse** to list everything available across your configured marketplaces — each entry shows its name, version, tier, and description. Click **Install** on any entry to add it.

You can also install directly from a source: paste a **GitHub repo** (`owner/repo`), a **zip URL**, or an **absolute local path** into the install field and click **Install**.

### Installed plugins

Each installed plugin is listed with how many skills and MCP servers it provides (e.g. `3 skills · 1/2 MCP`). For each one you can:

- **Enable / disable** it with the toggle.
- **Remove** it.

Changes take effect for new chat sessions. A warning icon marks a plugin that failed to load.

## Configuring marketplaces

A marketplace is a **GitHub plugin repository** (the same format Codex uses, e.g. `openai/plugins`). Configure the list in the **Custom** agent config (`config.toml`) under `pluginMarketplaces`:

```toml
pluginMarketplaces = ["openai/plugins"]
```

Open **Settings → Custom** to edit it. The repository is fetched and cached once; browsing and installing then read from the local cache, so browsing stays fast and works offline. If no marketplace is configured, **Browse** shows nothing — add an entry, or install from a direct source instead.
