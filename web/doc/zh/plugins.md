# 插件

## 这是什么

插件把可复用的 Agent 能力——**技能**和 **MCP 服务器**——打包成一个可安装的整体。插件按全局管理，向 Operon 运行的 Agent 提供能力。

## 插件如何工作

插件遵循 Codex 插件格式，可以携带：

- **技能** — 特定任务的指令，见[技能](skills)。
- **MCP 服务器** — 工具与服务连接，见 [MCP 服务器](mcp-servers)。

安装或启用插件后，新开对话以确保能力已加载。插件详情中也可以单独启用或停用服务器。

## 每个 Agent 都能用

已启用的插件会向 Operon、Claude Code、Codex、OpenCode 及其他支持的 Agent 提供技能与 MCP 服务器。

- **技能**会显示在 **Settings > Skills**，并标明由插件提供。请到 **Plugins** 管理。技能会同步到 Agent 的技能目录，兼容的终端 Agent 也能发现。已有的同名技能会被保留，冲突会显示在插件页。
- **MCP 服务器**显示在 **Settings > MCP > From plugins**。Operon 会把它们提供给自己启动的对话；独立启动 CLI 不会自动拿到这些连接。
- **只需登录一次。** 打开插件详情，对需要登录的服务器点 **Connect**。Operon 为它运行的 Agent 保存连接。未登录的服务器会提示先连接；连接后，如果旧对话仍然只显示连接提示，请新开对话。

## 管理插件

从左侧边栏底部打开 **Plugins**。独立技能在 **Settings > Skills** 管理。

### Marketplace（市场）

浏览或搜索已配置市场的插件。在卡片中查看技能、服务器与连接要求，然后点 **Install**。

**Install from a source** 也支持 GitHub 仓库（`owner/repo`）、zip URL 或本地绝对路径。

### Installed plugins（已安装）

打开已安装的插件，可以：

- 启用、停用插件，或为后续对话移除它。
- 连接、断开服务器，单独切换每个服务器的启用状态。
- 阅读技能，查看已连接服务器报告的工具。

警告会标出加载问题或技能冲突。安装插件并不等于完成服务登录。

## 配置市场

在 **Settings > Operon** 配置 GitHub 市场仓库：

```toml
pluginMarketplaces = ["openai/plugins"]
```

市场内容会缓存在本地。没有配置市场时，可以使用 **Install from a source**，或先添加仓库。
