# AI Providers

## What is it

AI Providers are the model API keys that power the **Operon Agent** — Operon's built-in agent. The CLI adapters (Claude Code, Codex, Antigravity, GitHub Copilot, Grok, Cursor, OpenCode, Kimi Code) bring their own authentication, but the Operon Agent talks to model APIs directly, so you add the keys for whichever providers you want it to use.

## Two kinds of provider

This is the distinction worth getting straight, because the two are configured in completely different places.

| | CLI adapters | API providers |
| --- | --- | --- |
| What it is | Operon drives a coding CLI you already have installed | Operon's own agent calls a model API directly |
| Authentication | The CLI's own login — your existing subscription or account | An API key you paste into Operon |
| Configured in | **Settings > Claude Code / Codex / …**, plus [environment and CLI paths](environment) | **Settings > AI Providers** |
| Chosen as | The adapter on an agent, or the picker above the chat input | The *Operon* agent, then a model from the dropdown |

### CLI adapters

| Adapter | Binary |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| GitHub Copilot | `copilot` |
| Cursor | `cursor-agent` |
| Antigravity | `agy_acp_server.par` (managed ACP server) |
| OpenCode | `opencode` |
| Kimi Code | `kimi` |
| Grok | `grok` |

Use each CLI's own authentication. Operon discovers installed binaries through your login shell and supports path overrides where offered. For Antigravity, open **Settings > Antigravity** to install its ACP server and check authentication before chatting.

The [terminal](terminal) menu can launch interactive CLIs too. Antigravity uses `agy` there, which is separate from its managed ACP server.

## Supported API providers

Open **Settings → AI Providers**. Operon supports:

**Anthropic**, **OpenAI**, **Google**, **DeepSeek**, **Kimi** (Moonshot), **GLM** (Zhipu), **MiniMax**, **Grok** (xAI), **OpenRouter**, and **Ollama** (local — no key required).

## Configuring a provider

For each provider you can set:

- **API key** — paste your key; the field has a show/hide toggle. Ollama needs no key.
- **Base URL** — optional. Defaults to the provider's standard endpoint; override it to use a proxy or a compatible gateway.
- **Enabled** — turn a provider on or off without deleting its key.
- **Custom Model IDs** — add model IDs by hand when a provider's model list can't be fetched automatically, or to pin a specific model.

Once a provider is enabled, its models appear in the model dropdown whenever the Operon Agent is selected. Use **Fetch Models** to retrieve a provider's model list.

> The CLI agents authenticate through their own tools and do not use these keys — AI Providers apply to the Operon Agent. To pick which model the Operon Agent uses, select it from the model dropdown above the chat input.
