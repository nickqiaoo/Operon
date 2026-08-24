# IM 平台集成

## 这是什么

IM 平台集成让 Operon 的 Agent 化身成 Slack / Telegram / Discord 等平台上的 bot，团队继续在自己熟悉的 IM 里协作，但消息会被 Agent 实时看到并按需响应。同一个本地 Agent 可以接到多个 IM 平台，credentials 互相独立。

IM 平台和 Operon 内置的「频道（Channels）」是两个**完全独立**的概念，它们不互通：IM Provider 工作在外部 IM 平台的频道（例如 Slack 频道）上，由 Agent 在 IM 端那边响应消息；Operon 内置的频道是桌面 UI 里的项目级协作空间。两者不会互相同步，配置入口也不一样。

## 工作模式（Mate vs Interactive）

每个 IM Provider 接入时需要选一种工作模式，**这两个模式是 IM Provider 层面的概念，不是 Operon 频道的属性**：

### Mate（团队队友模式）

Agent 作为一个普通 bot 用户加入 IM 频道 / 群，和人类成员平等：

- 默认沉默——@ 它它才回复，避免霸占对话
- 多个 Agent 可以共存于同一个 IM 频道
- Slack 的消息过滤策略：只忽略**自己**发出的消息，其他 bot（包括别的工具集成）的消息会正常进入处理流，不会漏
- Telegram 在 Mate 模式下的语义和 Slack 一致，只多一个坑：默认情况下 bot 在群里**只能看到 @ 提及和回复**（Telegram 的 privacy mode）。想让 Agent 像真正的群"队友"那样读到所有消息再决定要不要插话，去 BotFather 关掉：`/mybots` → 选 bot → **Bot Settings → Group Privacy → Turn off**。

适合：日常团队协作、把 AI 当作「队友」用。

### Interactive（向导式 DM 模式）

Agent 在私聊（DM）里以一对一向导形式工作：

- 每次会话独立，不共享历史
- 适合命令式 / 工具式交互（例如让 bot 跑一个 workflow、查工单）
- 不进入群聊，只响应私聊

适合：单用户 DM、命令式 / 表单式交互。

## 配置 IM Provider

进入 **Settings → Gateway → IM Platforms**：

1. **Add provider** — 选择平台（Slack / Telegram / Discord，凡是后端注册了 `IMSourceMeta` 的都会出现在列表里）。
2. **Mode** — Mate 或 Interactive。
3. **Agent** — 选择哪个本地 Agent 作为这个 bot 的「大脑」。同一个 Agent 可以接到多个 Provider；切换 Agent 等于换大脑。
4. **Display name** — bot 显示名（IM 端看到的名字）。
5. **Credentials** — 各平台所需的 token / app id / signing secret 等；表单字段会按所选平台动态变化（来自后端 `IMCredentialField` 描述）。
6. **Enabled** — 开关，关闭后 Provider 立即停止订阅事件。

保存后 Operon 启动对应的 Provider 实例，订阅事件流并加入指定的 IM 频道 / 群。

## Slack Quick Setup（用 manifest 自动建 App）

手动接 Slack 很麻烦——到 api.slack.com 建 App、勾几十个 scope、打开 Socket Mode、Install 到 workspace、再把两个 token 复制回 Operon。Operon 的 **Quick Setup** 向导用 Slack 的 Apps Manifest API 把"App 定义"这一半自动化掉。

**自动化的部分**：scopes、event subscriptions、Socket Mode 开关、interactivity、bot user —— 全部预配好。

**仍需手动的部分**：一次性粘贴一个 workspace **configuration token**（Slack 没提供生成它的 API），以及 App 创建完之后把 bot token 和 app-level token 复制回 Operon（Slack 也没提供这两个 token 的生成 API）。

> Quick Setup 当前只支持**单个 Slack workspace**，存下来的 config token 在该 workspace 下创建的所有 App 之间共享。

### 一次性：拿到 configuration token

Config token 是 per-workspace 的凭据，授权 Operon 在你的 workspace 里创建 / 修改 Slack App。TTL ~12 小时，自动 rotate —— 一旦存进 Operon 之后会自动续期。

1. 打开 <https://api.slack.com/apps>，登录到你要创建 App 的那个 workspace。
2. 右上角 **Your Apps** → 拉到底部 → **Manage app configuration tokens**。
3. 选 workspace → **Generate** → **两个值都复制**：**Access Token** 和 **Refresh Token**。

### 跑 Quick Setup

在 **Settings → Gateway → IM Platforms** 顶部点 **⚡ Slack Quick Setup**，向导分三步：

1. **Workspace token**（后续再用时会跳过）：
   - 粘贴 **Access Token** 和 **Refresh Token**。
   - Operon 会先做一次 rotate 验证，再把结果存到 KV 表里。之后会按需自动 refresh。
2. **Name your bot**：
   - 选 bot 化身的 **agent**（mate 模式）。
   - 填 **display name**（≤ 35 字符）。
   - 点 **Create App** —— Operon 调 `apps.manifest.create`，把完整 manifest（所有 scopes、events、Socket Mode、interactivity）一次到位。
3. **Install & paste tokens** —— 两个子步骤：
   - 点 **Open install page** → 在 Slack 那边点 **Allow** → 到 OAuth & Permissions 页复制 **Bot User OAuth Token**（`xoxb-` 开头），粘回 Operon。
   - 点 **Open Basic Information** → 拉到 **App-Level Tokens** → **Generate Token and Scopes**，scope 只勾 `connections:write` → 复制 token（`xapp-` 开头），粘回 Operon。
4. 点 **Finish**。Operon 会写入一条普通的 IM Provider 行（`source: slack`，mode `mate`，绑定到选的 agent）并立即启动。bot 在 Slack 端会立刻显示在线。

### 为什么两个 token 还是要手动？

Slack 把 App 的权限拆成三套独立凭据，目前只有一套可以自动化：

| Token | 用途 | 能自动化吗？ |
|---|---|---|
| `xoxb-`（Bot User OAuth） | 这个 workspace 里的 bot 身份；调 `chat.postMessage`、`reactions.add` 等 | ❌ 必须走 OAuth Install 流程 |
| `xapp-`（App-Level Token） | 用来开 Socket Mode 的 WSS 连接（`apps.connections.open`） | ❌ 没有公开 API，只能在 Basic Information 页手动生成 |
| Manifest 字段（scopes / events / Socket Mode 等） | App 定义 | ✅ `apps.manifest.create` |

Quick Setup 干掉的就是第三行那堆。前两个是 Slack 强制人工介入的步骤，绕不开。

### 后续使用 / 换 workspace

只要 Operon 里存着 config token，向导第 1 步就会被跳过。第 2 步顶部会显示已连接的 workspace 名字，并提供 **Use a different token** 链接 —— 点它会清掉旧凭据，重新走第 1 步给另一个 workspace。

### 出来的东西

Quick Setup 产物就是一条普通 IM Provider 行 —— 跟手动添加的 Provider 在同一个列表里，编辑 / 禁用 / 看 bindings / 删除全都走老接口。Quick Setup 只是创建阶段的快捷方式，运行时行为没区别。

## Telegram Quick Setup

1. 在 Telegram 里打开 [@BotFather](https://t.me/BotFather)，发 `/newbot`，按提示填显示名和 `@username`，复制返回的 token。
2. **Settings → Gateway → IM Platforms** 点 **⚡ Telegram Quick Setup**：
   - 粘贴 token
   - 填 **Display Name**、可选 **Description**、选 **Agent**
   - 点 **Finish**
3. 如果想让 bot 在群里读到所有消息（不止 @ 提及），到 BotFather 关掉 privacy：`/mybots` → 选 bot → **Bot Settings → Group Privacy → Turn off**，然后在完成页点 **Recheck privacy** 确认。

## Channel Bindings（IM 频道绑定）

Provider 和 Operon 内部的频道是两套独立体系——这里说的 **Channel Binding** 是 IM 平台**自身**的频道（例如某个 Slack 频道、某个 Telegram 群、某个 DM）和 Agent 之间的映射，不会出现在 Operon 内部的频道列表里。

绑定**自动产生**，不需要你手工添加：当 bot 被邀请进 IM 频道、或第一次收到 DM 时，系统会创建一条 `IMChannelBinding` 记录，把 `(source, sourceChannel) → agentId` 关联起来。**Settings → Gateway → IM Platforms** 里点 Provider 的 **Bindings** 按钮即可看到当前所有绑定，包含：

- `sourceChannel` 和 `sourceChannelName`（IM 平台侧的频道 ID 和名字）
- `channelKind`：`channel`（群 / 频道）或 `dm`（私聊）
- 绑定到的 `agentId`

如果要把某个 IM 频道交给另一个 Agent 处理，目前需要先让 bot 退出该频道再以新 Provider（绑定到目标 Agent）重新进入。

## Diff 预览（Interactive 模式，可选）

Interactive 模式下，Agent 跑文件编辑类工具时，工具入参本身就是 unified diff。把这段 diff 原样发到 IM 频道效果很差——Slack / Telegram 会渲染成一坨没有语法高亮、没有行号的 `+`/`-` 文本。Operon 的 IM gateway 可以改成把 diff 上传到一个轻量的 Cloudflare Worker，由它渲染成带语法高亮的网页，在工具通知旁边再追一条预览消息，里面就是这个链接。

**只 Interactive 模式走这套；Mate 模式不调 diff 服务**。这个能力**默认关闭**，不配置的话 Interactive 会话只发普通的工具通知，跳过 diff 预览那一步。

### 需要部署的服务

渲染器是一个独立的开源服务：**[operon-diff-worker](https://github.com/Nickqiaoo/operon-diff-worker)**（Apache-2.0）。它是一个 Cloudflare Worker，负责：

- 把 diff 存到 Cloudflare KV，带 TTL（默认 1 小时）。
- 服务端用 [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs) 渲染——语法高亮、行号、跟随明暗主题。
- 写入用 Bearer API Key 鉴权，对外的分享链接用 HMAC + 同一把 Key 签名。

部署在 Cloudflare 免费套餐下大概 5 分钟：克隆仓库 → `npx wrangler kv namespace create DIFFS` → `npx wrangler secret put API_KEY` → `pnpm run deploy`。完整步骤见 [仓库 README](https://github.com/Nickqiaoo/operon-diff-worker#deploy)。

### 接入 Operon

进入 **Settings → Diff Preview**，填两个字段：

- **Worker URL** — `wrangler deploy` 完成后打印出来的 `https://operon-diff-worker.<your-subdomain>.workers.dev` 地址。
- **API Key** — 跟 `wrangler secret put API_KEY` 时填的同一个值。

保存。两个字段都非空时，所有 Interactive Provider 立刻生效，不用按 Provider 单独配。任意一个字段为空就视为关闭（`diffPreviewService.isEnabled()` 返回 false），此时 Interactive 会话静默跳过预览步骤。

## 多平台并存

可以同时配置多个 Provider：

- 同一平台多个工作空间——例如两个 Slack workspace，每个一份 credentials
- 不同平台同一 Agent——一个 Agent 同时是 Slack 上的 bot 和 Telegram 上的 bot
- 不同 Agent 不同平台——根据团队习惯分发

每个 Provider 的状态、最近消息、错误信息都能在 **Gateway → IM Platforms** 卡片里看到。

## 故障排查

- **bot 加进 Slack 但没收到消息** — 手动建的 App 先检查 Slack OAuth scopes 和 Event Subscriptions 是否覆盖到该频道。Quick Setup 建的 App 这些已经预配好，重点查 `xoxb-` 和 `xapp-` 两个 token 是否有效、bot 是不是真的被加进了那个频道。Logs 页过滤 provider id 看入站事件。
- **Telegram bot 在群里只回复 @ 提及，其他消息无视** —— Privacy mode 开着（Telegram 的默认）。关法：BotFather → `/mybots` → 选 bot → **Bot Settings → Group Privacy → Turn off**，关掉后把 bot 重新踢出再拉回群，或者直接再发一条消息让 bot 重新拉一遍状态。之后可以到 Quick Setup 完成页点 **Recheck privacy** 确认状态。
- **Quick Setup 报 "token rotate failed"** — 存着的（或刚粘进去的）config token 失效了，或者过期超出自动恢复窗口。到 <https://api.slack.com/apps> → Your Apps → Manage app configuration tokens 重新生成一份，再跑一次向导。
- **Provider 标 enabled 但显示 disconnected** — credentials 失效（token revoked / app uninstalled），编辑后重新保存。
- **Agent 在 IM 端疯狂自说自话** — 检查是否误把 Mate 和 Interactive 配错；Mate 模式下 Agent 没被 @ 时不应主动发言，如果反复发言看下 Agent 的系统提示词是不是写了「主动汇报」。
- **多个 Agent 抢回复** — 同一 IM 频道里有多个 Provider（每个绑到不同 Agent），它们会各自独立响应；如果不想多 Agent 共存，把多余 Provider 的 Enabled 关掉，或让 bot 退出该频道。
