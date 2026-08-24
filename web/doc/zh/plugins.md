# 插件

## 这是什么

插件把可复用的 Agent 能力——**skills** 和 **MCP 服务器**——打包成一个可安装的整体。装一个插件，它携带的所有内容就一次性对 Agent 可用，无需逐个手动配置。

## 插件如何工作

插件遵循 Codex 插件格式，可以携带：

- 一个或多个 **skill**——扩展 Agent 能力的指令包（见 [Skills](skills)）。
- 一个或多个 **MCP 服务器**——Agent 可调用的外部工具服务（见 [MCP 服务器](mcp-servers)）。

插件按全局管理（而非按会话），改动对**新的聊天会话**生效。

## 管理插件

打开 **Settings → Plugins**，分为两部分。

### Marketplace（市场）

从你配置的源浏览并安装插件。点 **Browse** 会列出所有已配置市场中的可用插件——每条显示名称、版本、tier 和描述。在任意一条上点 **Install** 即可安装。

你也可以直接从来源安装：在安装输入框粘贴 **GitHub 仓库**（`owner/repo`）、**zip URL** 或**本地绝对路径**，再点 **Install**。

### Installed plugins（已安装）

每个已安装插件都会显示它提供的 skill 和 MCP 服务器数量（如 `3 skills · 1/2 MCP`）。对每个插件你可以：

- 用开关 **启用 / 停用**。
- **移除**。

改动对新的聊天会话生效。加载失败的插件会标一个警告图标。

## 配置市场

一个市场就是一个 **GitHub 插件仓库**（与 Codex 相同的格式，如 `openai/plugins`）。在 **Custom** Agent 配置（`config.toml`）的 `pluginMarketplaces` 里配置列表：

```toml
pluginMarketplaces = ["openai/plugins"]
```

打开 **Settings → Custom** 编辑。仓库只会拉取并缓存一次，之后浏览和安装都读本地缓存，所以浏览很快、也能离线用。如果没有配置市场，**Browse** 不会有内容——加一条，或者直接从来源安装。
