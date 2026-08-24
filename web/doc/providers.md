# AI Providers

## What is it

AI Providers are the model API keys that power the **Operon Agent** — Operon's built-in agent (configured as the *Custom* agent). The CLI adapters (Claude Code, Codex, Gemini CLI, GitHub Copilot, Grok, Cursor, OpenCode, Kimi Code) bring their own authentication, but the Operon Agent talks to model APIs directly, so you add the keys for whichever providers you want it to use.

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
| Gemini CLI | `gemini` |
| OpenCode | `opencode` |
| Kimi Code | `kimi` |
| Grok | `grok` |

You authenticate these the way you normally would — by logging in with the tool itself. Operon does not store or proxy those credentials; it runs the binary and talks to it. If a CLI works in your terminal, it will generally work here, since Operon resolves binaries through your login shell.

Each of these can also be opened as a plain [terminal](terminal) session when you want the CLI's own interface instead.

## Supported API providers

Open **Settings → AI Providers**. Operon supports:

**Anthropic**, **OpenAI**, **Google**, **DeepSeek**, **Kimi** (Moonshot), **GLM** (Zhipu), **MiniMax**, **Grok** (xAI), **OpenRouter**, and **Ollama** (local — no key required).

## Configuring a provider

For each provider you can set:

- **API key** — paste your key; the field has a show/hide toggle. Ollama needs no key.
- **Base URL** — optional. Defaults to the provider's standard endpoint; override it to use a proxy or a compatible gateway.
- **Enabled** — turn a provider on or off without deleting its key.
- **Manual models** — add model IDs by hand when a provider's model list can't be fetched automatically, or to pin a specific model.

Once a provider is enabled, its models appear in the model dropdown whenever the Operon Agent is selected. Use the refresh button to re-fetch a provider's model list.

> The CLI agents authenticate through their own tools and do not use these keys — AI Providers apply to the Operon Agent. To pick which model the Operon Agent uses, select it from the model dropdown above the chat input.
