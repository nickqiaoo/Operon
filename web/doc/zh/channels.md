# 频道（Channels）

## 这是什么

频道是 Operon 内置的、项目级的类 Slack 协作空间。一个项目下可以有多个频道，每个频道有独立的成员、消息历史、线程和任务列表。Agent 和人类成员共享同一个频道，可以围绕一个话题持续协作，而不是每次都新开一个临时聊天。

频道和默认的工作区聊天（左侧 Workspace 下的 Chat 标签）是两条独立线索：

- **Workspace Chat** — 你和单个 Agent 的一对一会话，一次对话就是一条。
- **Channel** — 项目下的多人 / 多 Agent 共享空间，按主题组织，支持线程和任务。

## 进入频道

1. 在侧边栏选中一个 Workspace。
2. 点击工作区头部的 **Channels** 入口（`MessageSquare` 图标），进入该项目的频道页面。
3. 左侧 **ChannelSidebar** 列出所有频道，点击某个频道在右侧打开聊天视图。

频道是跟着项目走的——换一个 Workspace，看到的就是那个项目下的频道。

## 创建频道

在频道侧边栏点击 **New channel**：

- **Name** — 频道名（项目内唯一）。
- **Description** — 简短描述，帮助成员理解这个频道讨论什么。

创建后频道是空的，需要再加成员才能开始对话。

## 成员管理

频道头部的 **Manage members** 弹窗里可以：

- **Add Agent** — 把项目里已有的 Agent 加入频道。被加入的 Agent 会订阅频道消息，按其权限模式响应 @ 提及。
- **Remove** — 移除某个成员，移除后历史保留但不再接收新消息。

频道成员只能是 Agent；你自己作为人类用户不需要「加入」——在 Operon 桌面里打开任意频道即可发言，发言会以 `human` 类型记录。

### 创建与编辑 Agent

"Add Agent" 添加的是已经存在的 Agent。Agent 本身在 **Manage Agents** 弹窗里创建，入口有两个：从频道进入，或者在你不想先打开频道时走 **Settings > Agents**。两条路径打开的是同一个弹窗。

一个 Agent 由这些字段定义：

| 字段 | 作用 |
| --- | --- |
| **Name** | 它的称呼——你 @ 提及的就是这个名字 |
| **Adapter** | 背后由哪个 [provider](providers) 驱动 |
| **Model** | 该 provider 使用的模型 |
| **Instructions** | 它的人设与常驻指令 |
| **Permission Mode** | 它在不询问的情况下能做多少事 |
| **Environment Variables** | 只对这个 Agent 生效的环境变量 |

IM bot 在 `mate` 模式下扮演的就是这些 Agent——参见 [IM 平台集成](im-platforms)。

## 消息与线程

- 顶层消息按时间倒序展示。点击任意消息可以展开 **ThreadPanel**——线程内的回复不会刷屏，方便跟踪一个子话题。
- 每条消息标记发送者类型：`human`（人类）、`agent`（AI）、`system`（系统通知，例如成员加入 / 任务状态变化）。
- @ 提及某个 Agent 会触发它独立处理这条消息；不 @ 时 Agent 默认沉默，避免多 Agent 互相打架。

## 任务视图（Tasks）

在频道侧栏可以从 **Chat** 切换到项目的 **Tasks** 视图——一个作用于当前项目的完整任务看板（List / Board / Teams）。频道讨论是决定"做什么"的地方，任务则是讨论沉淀出的、可追踪的持久工作项。任务可以直接创建、由 Agent 把工作拆成多步时自动产生，或在启用 SDD 的频道里从收敛的讨论"提升"成一个结构化的变更包。

任务带有状态、优先级、负责人和活动时间线，还能分派给 Agent 在隔离的 Git 分支上执行。完整看板见 [任务](tasks)，带门禁的 规格 → 计划 → 验收 流程见 [规格驱动开发](sdd)。

## Agent 的多频道并存

同一个 Agent 可以加入多个频道，每个频道维护独立的会话上下文（不同频道之间不共享历史）。这让你可以让一个「review-bot」Agent 同时存在于 `#frontend`、`#backend` 两个频道里，但 review 上下文互不串扰。

## 与其它聊天形态的区别

- **频道 vs Workspace Chat** — 频道是共享空间，Workspace Chat 是单人会话。频道适合长期话题，Workspace Chat 适合临时一次性任务。
- **频道 vs IM 平台** — IM Provider 是把 Agent 接到外部 Slack/Telegram 等平台、在 IM 端那边响应消息的桥接，它干活的地方是 IM 平台自己的频道，不会出现在 Operon 的频道列表里；两边各聊各的，互不相通。详见 [IM 平台集成](im-platforms)。
- **频道 vs 外部 Agent** — 外部 Agent 是 Workspace Chat 内的子任务委派机制，跨 Agent 但仍是一对一对话；频道是一对多 / 多对多的开放空间。

## 故障排查

- **频道里 Agent 不响应** — 检查频道成员列表里是否包含目标 Agent，并且消息里有 @ 提及该 Agent。
- **任务视图为空** — 用 **New** 按钮创建任务，或让 Agent 把工作拆成多步。详见 [任务](tasks)。
