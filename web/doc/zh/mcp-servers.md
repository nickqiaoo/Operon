# MCP 服务器

## 这是什么

MCP（Model Context Protocol）是一个开放标准，用来把 AI 模型接到外部的工具和数据上。在 Operon 里配好 MCP 服务器之后，Agent 就能在对话中直接读你的数据库、调你的 API、查你的文档。

## 服务器类型

### stdio

把一个本地命令当成 MCP 服务器跑起来，通过标准输入输出通信。

- **Command** — 要跑的可执行文件（比如 `npx`、`python`）。
- **Arguments** — 命令行参数，空格分隔。
- **Environment Variables** — 额外的环境变量，`KEY=VALUE`，一行一条。

### HTTP

通过 HTTP 连到一个 MCP 服务器。

- **URL** — 服务器地址。
- **Headers** — 额外的 HTTP 头，`KEY=VALUE` 格式。

### SSE

用 Server-Sent Events 连到 MCP 服务器，支持实时流式传输。

- **URL** — SSE 地址。
- **Headers** — 额外的 HTTP 头，`KEY=VALUE` 格式。

## 配置

1. 进入 **Settings > MCP**。
2. 点 **Add Server**。
3. 起一个不重名的名字，选好类型。
4. 填连接信息。
5. 展开 **Advanced** 可以设环境变量和自定义头。
6. 点 **Save**。

配好的服务器会提供给支持 MCP 的 Agent，包括 Operon、Claude Code、Codex、OpenCode 和 ACP 适配器。可用传输方式与认证取决于 Agent 能力。

已启用[插件](plugins)提供的服务器列在 **From plugins** 中，请到 **Plugins** 管理连接与启用状态。

## 管理

- **编辑** — 点开已有的服务器就能改。
- **删除** — 不用了就移除。
- 名字不能重复。

> **注意**：改完 MCP 配置后，请新开对话，确保 Agent 收到新配置。
