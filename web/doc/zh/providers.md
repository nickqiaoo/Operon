# AI Providers（模型提供商）

## 这是什么

AI Providers 就是 **Operon Agent**（Operon 自带的那个 Agent，在设置里叫 *Custom*）用来调模型的 API key。CLI 适配器（Claude Code、Codex、Gemini CLI、GitHub Copilot、Grok、Cursor、OpenCode、Kimi Code）自带各自的认证，而 Operon Agent 直接对接模型 API，所以你需要为想用的提供商填入 key。

## 两类 provider

这个区别值得先弄清楚，因为两者的配置位置完全不同。

| | CLI 适配器 | API 提供商 |
| --- | --- | --- |
| 是什么 | Operon 驱动你已经装好的编码 CLI | Operon 自带的 Agent 直接调用模型 API |
| 认证方式 | 用 CLI 自己的登录——你已有的订阅或账号 | 你粘贴进 Operon 的 API key |
| 配置位置 | **Settings > Claude Code / Codex / …**，以及[环境与 CLI 路径](environment) | **Settings > AI Providers** |
| 如何选用 | 作为 Agent 的 adapter，或聊天输入框上方的选择器 | 选 *Operon* Agent，再从下拉里选模型 |

### CLI 适配器

| 适配器 | 二进制 |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| GitHub Copilot | `copilot` |
| Cursor | `cursor-agent` |
| Gemini CLI | `gemini` |
| OpenCode | `opencode` |
| Kimi Code | `kimi` |
| Grok | `grok` |

这些工具按你平时的方式认证即可——用工具自己登录。Operon 不存储也不代理这些凭据；它只是运行那个二进制并与之通信。如果某个 CLI 在你的终端里能用，在这里通常也能用，因为 Operon 通过你的登录 shell 解析二进制路径。

当你想用 CLI 自己的界面时，这些工具也都可以作为普通的[终端](terminal)会话打开。

## 支持的 API 提供商

打开 **Settings → AI Providers**。Operon 支持：

**Anthropic**、**OpenAI**、**Google**、**DeepSeek**、**Kimi**（Moonshot）、**GLM**（智谱）、**MiniMax**、**Grok**（xAI）、**OpenRouter**，以及 **Ollama**（本地，无需 key）。

## 配置一个提供商

每个提供商可以设置：

- **API key**——粘贴你的 key，输入框带显示/隐藏切换。Ollama 不需要 key。
- **Base URL**——可选。默认用该提供商的官方地址；想走代理或兼容网关就填这里。
- **Enabled**——在不删除 key 的前提下启用或停用某个提供商。
- **Manual models（手动模型）**——当某个提供商的模型列表无法自动拉取，或你想锁定某个具体模型时，手动填入模型 ID。

启用某提供商后，选中 Operon Agent 时它的模型就会出现在模型下拉框里。用刷新按钮可以重新拉取该提供商的模型列表。

> CLI Agent 通过各自的工具认证，不使用这些 key——AI Providers 只对 Operon Agent 生效。要指定 Operon Agent 用哪个模型，在聊天输入框上方的模型下拉框里选择。
