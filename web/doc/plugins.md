# Plugins

## What is it

Plugins bundle reusable agent capabilities — **skills** and **MCP servers** — into one installable package. They are managed globally and supply capabilities to the agents Operon runs.

## How plugins work

A plugin follows the Codex plugin format and can carry:

- **Skills** — task-specific instructions; see [Skills](skills).
- **MCP servers** — tools and service connections; see [MCP Servers](mcp-servers).

Install or enable a plugin, then start a new conversation to ensure its capabilities are loaded. Individual servers can be enabled or disabled from the plugin detail.

## Every agent gets them

Enabled plugins supply skills and MCP servers to Operon, Claude Code, Codex, OpenCode, and the other supported agents.

- **Skills** appear in **Settings > Skills** marked as provided by the plugin. Manage them from **Plugins**. They are synced to agent skill folders, so compatible terminal agents can discover them too. Existing skills with the same name are kept; conflicts are shown on the plugin page.
- **MCP servers** appear under **Settings > MCP > From plugins**. Operon supplies them to its conversations; a CLI launched independently does not receive those connections automatically.
- **Sign in once.** Open the plugin detail and use **Connect** for a server that requires sign-in. Operon keeps the connection for the agents it runs. An unsigned-in server asks you to connect first; after connecting, start a new conversation if an existing one still shows only the connection prompt.

## Managing plugins

Open **Plugins** from the bottom of the left sidebar. Skills alone are managed in **Settings > Skills**.

### Marketplace

Browse or search the gallery of plugins from your configured marketplaces. Open a card to inspect its skills, servers, and connection requirements, then click **Install**.

**Install from a source** also accepts a GitHub repository (`owner/repo`), a zip URL, or an absolute local path.

### Installed plugins

Open an installed plugin to:

- Enable or disable the plugin, or remove it for future conversations.
- Connect or disconnect its servers and toggle each server's enabled state.
- Read its skills and inspect the tools reported by connected servers.

Warnings identify loading problems or skill conflicts. Installation alone does not complete a service's sign-in.

## Configuring marketplaces

Configure GitHub marketplace repositories in **Settings > Operon**:

```toml
pluginMarketplaces = ["openai/plugins"]
```

Marketplace content is cached locally. With no configured marketplace, use **Install from a source** or add a repository first.
