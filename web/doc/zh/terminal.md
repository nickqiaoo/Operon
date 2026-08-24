# 终端

## 这是什么

一个真正的 shell，作为面板标签停在聊天旁边。它从当前 workspace 目录启动，因此你一进去就已经身处 Agent 正在工作的位置。

在右侧或底部面板打开 **Terminal** 标签即可——与 Files、Review、Browser 共用同一套面板系统。

## 会话不随界面消失

shell 进程并不绑定在显示它的那个标签上。关闭面板、切换标签，或把终端从底部面板拖到侧边，同一个会话都会继续运行——命令历史、正在跑的进程、当前工作目录全都原封不动。

每个 workspace 有自己独立的一组面板标签。离开某个项目会把它的终端"寄存"起来，回来时再恢复。

## 启动 CLI Agent

**New Terminal** 菜单可以直接开一个已经跑起某个编码 CLI 的终端，而不是一个空 shell：

`claude` · `codex` · `copilot` · `cursor-agent` · `gemini` · `opencode` · `kimi` · `grok`

当你想用 CLI 自己的界面时——它的斜杠命令、它的交互提示、它的输出格式——这就是那个出口，同时又把它留在 Operon 内部、留在正确的仓库里。它就是你自己会敲的那个二进制；如果它不在 `PATH` 上，终端会照常报 "command not found"。

没有交互式 CLI 的 provider 不会出现在这个菜单里。

> 这些终端会话与 Operon 自己的 Agent 对话相互独立。终端里跑的 CLI 不共享聊天的历史、[记忆](memory)或 [MCP 服务器](mcp-servers)——它就是那个工具本身在运行。
