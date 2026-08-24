# 配置文件

大部分设置都有图形界面。这个页签负责剩下的部分——Agent 和 CLI 真正读取的那些配置文件，就地编辑，不用切到终端。

这里的每个编辑器在保存前都会校验：JSON 和 TOML 会随你输入实时解析，语法错误会带着行号和列号报出来，而不是被写进磁盘。

## Operon 自己的配置

**Settings > Custom** 编辑的是 `~/.operon/config.toml`。它控制三件事：

| 配置项 | 作用 |
| --- | --- |
| 权限规则 | 哪些动作自动放行，哪些要停下来询问 |
| 循环控制 | `maxTurns` 与 `maxStepsPerTurn`——Agent 在必须回来找你之前，最多能连续工作多久 |
| `pluginMarketplaces` | [插件](plugins)从哪些 GitHub 仓库浏览和安装 |

关于这个文件的读取方式，有两点值得知道：

- **它是分层的，且按 workspace 生效。** user、project、local 三层会被合并，结果按 git 根目录加载——因此某个仓库可以携带自己的规则，而不必改动你的全局配置。
- **它不配置 MCP。** MCP 服务器有自己的 `mcp.json` 系列文件，见 [MCP 服务器](mcp-servers)。这个拆分是刻意的。
- **文件写坏了不会把你卡住。** TOML 解析不了时，Operon 记一条警告，然后按默认值继续跑，而不是让对话直接失败。

## CLI provider 配置

同一个编辑器也能打开 Operon 所驱动的那些 CLI 的配置文件，让你不必离开 App 就能调整它们。这些是各工具自己的文件、自己的格式，Operon 只负责读写。

| 页签 | 目录 | 文件 |
| --- | --- | --- |
| **Claude Code** | `~/.claude` | `settings.json`、`CLAUDE.md`、`keybindings.json` |
| **Codex** | `~/.codex` | `config.toml`、`instructions.md` |
| **OpenCode** | `~/.config/opencode` | `opencode.json`、`AGENTS.md` |
| **Kimi** | `~/.kimi` | `config.toml` |
| **Grok** | `~/.grok` | `config.toml` |

其中的 markdown 文件（`CLAUDE.md`、`instructions.md`、`AGENTS.md`）是全局自定义指令——它们对该 CLI 运行的每一个项目都生效，因此不适合放任何项目专属的内容。
