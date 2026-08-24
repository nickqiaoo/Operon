# MCP Servers

## What is it

MCP (Model Context Protocol) is an open standard that lets AI models connect to external tools and data sources. Operon supports configuring MCP servers so your AI agents can access databases, APIs, documentation, and other services directly during conversations.

## Server Types

### stdio

Runs a local command as an MCP server. The AI communicates with it through standard input/output.

- **Command** — The executable to run (e.g., `npx`, `python`).
- **Arguments** — Command-line arguments, space-separated.
- **Environment Variables** — Custom env vars in `KEY=VALUE` format, one per line.

### HTTP

Connects to an MCP server over HTTP.

- **URL** — The server endpoint.
- **Headers** — Custom HTTP headers in `KEY=VALUE` format.

### SSE

Connects to an MCP server using Server-Sent Events for real-time streaming.

- **URL** — The SSE endpoint.
- **Headers** — Custom HTTP headers in `KEY=VALUE` format.

## Configuration

1. Go to **Settings > MCP**.
2. Click **Add Server**.
3. Enter a unique name and select the server type.
4. Fill in the connection details.
5. Expand **Advanced** for environment variables or custom headers.
6. Click **Save**.

All configured MCP servers are available to all AI providers that support MCP (Claude Code, Codex, Gemini CLI).

## Managing Servers

- **Edit** — Click an existing server to modify its configuration.
- **Delete** — Remove a server you no longer need.
- Names must be unique across all servers.

> **Note**: After modifying MCP server configuration, you need to close the current chat tab and reopen it for the new configuration to take effect.
