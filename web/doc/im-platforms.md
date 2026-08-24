# IM Platform Integrations

## What is it

IM Platform integrations let an Operon agent show up as a bot on Slack / Telegram / Discord and similar platforms. Your team keeps using the IM tool they're familiar with, and the agent sees and answers messages there in real time. The same local agent can be wired into multiple IM platforms with independent credentials.

IM Platforms and Operon's built-in **Channels** are two **completely independent** concepts and do not interconnect: an IM Provider lives on the external IM platform's channels (e.g. a Slack channel) and the agent answers there; Operon's internal channels are project-scoped collaboration spaces inside the desktop UI. The two never sync, and they're configured from different places.

## Modes (Mate vs Interactive)

Each IM Provider chooses one of two operating modes. **These modes are properties of the IM Provider, not of an Operon Channel:**

### Mate (team-mate mode)

The agent joins an IM channel / group as an ordinary bot user, equal to human members:

- Silent by default — only responds when `@`-mentioned, so it doesn't dominate the conversation.
- Multiple agents can coexist in the same IM channel.
- Slack message-filtering policy: only **the agent's own** outgoing messages are filtered; messages from other bots (including those of other tools) flow through normally and won't be missed.
- Telegram has the same Mate semantics as Slack, with one extra wrinkle: by Telegram's default a bot only sees `@`-mentions and replies in groups (privacy mode). To let the agent read every group message and pick when to chime in, turn privacy off in BotFather: send `/mybots` → pick the bot → **Bot Settings** → **Group Privacy** → **Turn off**.

Use this for: day-to-day team collaboration, treating the AI as a "teammate".

### Interactive (DM wizard mode)

The agent operates one-on-one in DMs with a wizard-style flow:

- Each session is independent (no shared history).
- Suited for command / form-style interactions (e.g. "have the bot run a workflow", "look up an issue").
- Doesn't enter group chats; only responds in DMs.

Use this for: single-user DMs, command / form-based interactions.

## Configuring an IM Provider

Open **Settings → Gateway → IM Platforms**:

1. **Add provider** — pick the platform (Slack / Telegram / Discord — anything the backend exposes via `IMSourceMeta` shows up here).
2. **Mode** — Mate or Interactive.
3. **Agent** — pick which local agent acts as this bot's brain. The same agent can power multiple Providers; switching the Agent here is effectively a brain swap.
4. **Display name** — bot display name (what appears in the IM platform).
5. **Credentials** — token / app id / signing secret etc. The credential fields are dynamic per platform (driven by the backend's `IMCredentialField` descriptors).
6. **Enabled** — switch. Disabling immediately stops the Provider from subscribing to events.

On save, Operon spins up a Provider instance, subscribes to its event stream, and joins the configured IM channels / groups.

## Slack Quick Setup (auto-create app via manifest)

Manual Slack onboarding is tedious — create the app on api.slack.com, tick dozens of scopes, enable Socket Mode, install to workspace, then copy two tokens back. Operon's **Quick Setup** wizard automates the app-definition half by calling Slack's Apps Manifest API on your behalf.

**What's automated**: scopes, event subscriptions, Socket Mode toggle, interactivity, bot user — all preconfigured.

**What you still do manually**: paste a workspace **configuration token** once (Slack provides no API to mint one), and after creation copy the bot + app-level tokens back into Operon (Slack provides no API for those two either).

> Quick Setup currently targets **one Slack workspace at a time**. The stored config token is shared across all apps you create from it.

### One-time: get a configuration token

A config token is a per-workspace credential that lets Operon create / modify Slack apps in that workspace on your behalf. Tokens have a ~12 h TTL and rotate themselves — once stored, Operon refreshes them automatically.

1. Open <https://api.slack.com/apps> and sign in to the workspace you want apps created in.
2. Top-right **Your Apps** → scroll to the bottom → **Manage app configuration tokens**.
3. Pick the workspace → **Generate**. Copy **both** values: the **Access Token** and the **Refresh Token**.

### Run Quick Setup

From **Settings → Gateway → IM Platforms**, click **⚡ Slack Quick Setup**. The wizard has three steps:

1. **Workspace token** (skipped on subsequent runs):
   - Paste **Access Token** and **Refresh Token**.
   - Operon validates them by performing one rotate call and stores the result in its KV table. Future calls auto-refresh as needed.
2. **Name your bot**:
   - Pick the **agent** this bot will embody (mate mode).
   - Pick a **display name** (≤ 35 chars).
   - Click **Create App** — Operon calls `apps.manifest.create` with the full manifest (all required scopes, events, Socket Mode, interactivity).
3. **Install & paste tokens** — two sub-steps:
   - Click **Open install page** → in Slack click **Allow** → on the OAuth & Permissions page copy the **Bot User OAuth Token** (starts with `xoxb-`) and paste it back into Operon.
   - Click **Open Basic Information** → scroll to **App-Level Tokens** → **Generate Token and Scopes** with the `connections:write` scope only → copy the token (starts with `xapp-`) and paste it back.
4. Click **Finish**. Operon writes a normal IM Provider row (`source: slack`, mode `mate`, bound to the agent you picked) and immediately starts it. The bot will appear online in Slack.

### Why are two tokens still manual?

Slack splits app authority across three independent credentials. Only one is automatable today:

| Token | Purpose | Automatable? |
|---|---|---|
| `xoxb-` (Bot User OAuth) | Bot identity in this workspace; used for `chat.postMessage`, `reactions.add`, etc. | ❌ Requires the OAuth install flow. |
| `xapp-` (App-Level Token) | Opens the Socket Mode WSS connection (`apps.connections.open`). | ❌ No public API to mint; must use the Basic Information UI. |
| Manifest fields (scopes, events, Socket Mode, …) | App definition. | ✅ `apps.manifest.create`. |

Quick Setup automates the third row. The first two need human-in-the-loop steps.

### Subsequent runs / changing workspace

The wizard's first step is skipped as long as a workspace config token is stored. Step 2 shows the connected workspace name and offers a **Use a different token** link to wipe the stored credential and re-enter the flow for another workspace.

### What you end up with

A Quick Setup result is just an ordinary IM Provider row — you can edit, disable, view bindings, or delete it from the same list as manually-added providers. Quick Setup only shortens creation; nothing about the runtime is different.

## Telegram Quick Setup

1. Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, follow the prompts to pick a display name and `@username`, and copy the token it returns.
2. In **Settings → Gateway → IM Platforms**, click **⚡ Telegram Quick Setup**:
   - Paste the token
   - Fill **Display Name**, optional **Description**, and pick an **Agent**
   - Click **Finish**
3. To let the bot read every group message (not just `@`-mentions), turn privacy off in BotFather: `/mybots` → pick the bot → **Bot Settings → Group Privacy → Turn off**, then click **Recheck privacy** on the completion screen to confirm.

## Channel Bindings (IM-side)

Providers and Operon's internal channels are two separate systems — what's called **Channel Binding** here maps the **IM platform's own channels** (a Slack channel, a Telegram group, a DM) to an agent. These do **not** show up in Operon's internal channel list.

Bindings are **created automatically** — you don't add them by hand. When the bot is invited into an IM channel, or receives its first DM, an `IMChannelBinding` record is created linking `(source, sourceChannel) → agentId`. From **Settings → Gateway → IM Platforms** click the **Bindings** button on a Provider to view all current bindings, including:

- `sourceChannel` and `sourceChannelName` (the IM platform's channel ID and name).
- `channelKind`: `channel` (group / channel) or `dm` (direct message).
- The bound `agentId`.

To re-route an IM channel to a different agent, currently the bot must leave that channel and re-enter via a new Provider that's bound to the target agent.

## Diff preview (Interactive mode, optional)

When an Interactive-mode session runs a file-editing tool, the underlying tool input is a unified diff. Posting that diff into an IM channel as plain text reads badly — Slack / Telegram render it as a wall of `+`/`-` lines with no syntax highlighting and no line numbers. Operon's IM gateway can instead upload the diff to a small Cloudflare Worker that renders it as a syntax-highlighted web page, and post the link as a follow-up message next to the tool notification.

This applies **only to Interactive mode** — Mate-mode providers never touch the diff service. The feature is **off by default**; if you don't configure it, Interactive sessions simply skip the diff preview message and post only the regular tool notification.

### What you have to deploy

The renderer is a separate open-source service: **[operon-diff-worker](https://github.com/Nickqiaoo/operon-diff-worker)** (Apache-2.0). It is a Cloudflare Worker that:

- Stores diffs in Cloudflare KV with a TTL (default 1 hour).
- Server-side renders them with [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs) — syntax highlighting, line numbers, dark/light theme.
- Gates writes with a Bearer API key, and signs share URLs with HMAC + the same key.

Deploying is a 5-minute job on Cloudflare's free plan — clone the repo, run `npx wrangler kv namespace create DIFFS`, `npx wrangler secret put API_KEY`, then `pnpm run deploy`. Full walkthrough in the [repo README](https://github.com/Nickqiaoo/operon-diff-worker#deploy).

### Wiring it into Operon

Open **Settings → Diff Preview** and fill in:

- **Worker URL** — the `https://operon-diff-worker.<your-subdomain>.workers.dev` address Wrangler prints after deploy.
- **API Key** — the same value you passed to `wrangler secret put API_KEY`.

Save. Once both fields are non-empty, every Interactive provider picks the new config up immediately; no per-Provider setting is needed. Leaving either field empty disables the upload path (`diffPreviewService.isEnabled()` returns false), and Interactive sessions silently skip the preview step.

## Multi-platform coexistence

You can configure multiple Providers at once:

- Same platform, different workspaces — e.g. two Slack workspaces with separate credentials.
- Different platforms, same agent — one agent acts as a bot on both Slack and Telegram.
- Different platforms, different agents — split however your team prefers.

The state, latest messages, and errors of each Provider are visible on the **Gateway → IM Platforms** card.

## Troubleshooting

- **Bot is in Slack but not receiving messages** — For manually-created apps, verify Slack OAuth scopes and Event Subscriptions cover the channel. Apps created via Quick Setup have these preconfigured, so check that both `xoxb-` and `xapp-` tokens are valid and the bot is actually a member of the channel. In the Logs page filter by the provider id to see incoming events.
- **Telegram bot is in a group but only responds when @-mentioned** — Privacy mode is on (Telegram's default). Fix: BotFather → `/mybots` → pick the bot → **Bot Settings → Group Privacy → Turn off**, then re-invite the bot or just send another message. Click **Recheck privacy** in the Quick Setup completion screen to confirm.
- **Quick Setup fails with "token rotate failed"** — Your stored config token (or the one you just pasted) is invalid or expired beyond auto-recovery. Regenerate it from <https://api.slack.com/apps> → Your Apps → Manage app configuration tokens, then re-run the wizard.
- **Provider is enabled but reports disconnected** — credentials expired (token revoked / app uninstalled); edit and re-save.
- **Agent monologues in the IM channel** — Check Mate vs Interactive isn't misconfigured. In Mate mode the agent should not speak unmentioned; if it does, look at the agent's system prompt for any "proactively report" instruction.
- **Multiple agents fight to reply** — If several Providers (each bound to a different agent) are active in one IM channel, they'll each respond independently. To avoid that, disable redundant Providers, or have the bot leave the channel.
