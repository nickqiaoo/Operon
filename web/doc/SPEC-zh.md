# Symphony 服务规范

状态：草案 v1（与语言无关）

目的：定义一个编排编码智能体（Coding Agents）以完成项目工作的服务。

## 1. 问题陈述

Symphony 是一个长运行的自动化服务，它持续从问题追踪器（在此规范版本中为 Linear）读取工作任务，为每个问题创建一个隔离的工作空间，并在该工作空间内为该问题运行一个编码智能体会话。

该服务解决了四个操作性问题：

- 它将问题执行转化为可重复的守护进程工作流，而不是手动脚本。
- 它在每个问题的工作空间中隔离智能体的执行，因此智能体命令仅在每个问题的工作空间目录内运行。
- 它将工作流策略保存在代码仓库中（`WORKFLOW.md`），以便团队随代码一起对智能体提示词和运行时设置进行版本控制。
- 它提供了足够的观测能力来运行和调试多个并发的智能体运行。

预期实现应明确记录其信任和安全态势。本规范不要求单一的审批、沙箱或操作员确认策略；某些实现可能针对具有高信任配置的受信任环境，而其他实现可能需要更严格的审批或沙箱。

重要边界：

- Symphony 是一个调度器/运行器和追踪器读取器。
- 票据写入（状态转换、评论、PR 链接）通常由编码智能体使用工作流/运行时环境中可用的工具执行。
- 成功的运行可能会结束于工作流定义的移交状态（例如 `Human Review`），而不一定是 `Done`。

## 2. 目标与非目标

### 2.1 目标

- 以固定的节奏轮询问题追踪器，并以有界的并发度分发工作。
- 为分发、重试和状态同步维护单一的权威编排器状态。
- 创建确定性的每个问题工作空间并跨运行保留它们。
- 当问题状态变化使其不符合条件时，停止活跃的运行。
- 通过指数退避从瞬态故障中恢复。
- 从仓库拥有的 `WORKFLOW.md` 契约加载运行时行为。
- 暴露操作员可见的观测能力（至少是结构化日志）。
- 支持重启恢复，而无需持久化数据库。

### 2.2 非目标

- 丰富的 Web UI 或多租户控制平面。
- 规定特定的仪表板或终端 UI 实现。
- 通用工作流引擎或分布式作业调度器。
- 如何编辑票据、PR 或评论的内置业务逻辑。（该逻辑存在于工作流提示词和智能体工具中。）
- 强制要求超出编码智能体和主机操作系统提供的强大沙箱控制。
- 为所有实现强制要求单一的默认审批、沙箱或操作员确认态势。

## 3. 系统概述

### 3.1 主要组件

1. `Workflow Loader`（工作流加载器）
   - 读取 `WORKFLOW.md`。
   - 解析 YAML 前置内容（front matter）和提示词正文。
   - 返回 `{config, prompt_template}`。

2. `Config Layer`（配置层）
   - 暴露工作流配置值的类型化 Getter。
   - 应用默认值和环境变量间接引用。
   - 执行编排器在分发前使用的验证。

3. `Issue Tracker Client`（问题追踪器客户端）
   - 获取处于活跃状态的候选问题。
   - 获取特定问题 ID 的当前状态（状态同步）。
   - 在启动清理期间获取终端状态的问题。
   - 将追踪器有效负载归一化为稳定的问题模型。

4. `Orchestrator`（编排器）
   - 拥有轮询时钟。
   - 拥有内存中的运行时状态。
   - 决定分发、重试、停止或释放哪些问题。
   - 追踪会话指标和重试队列状态。

5. `Workspace Manager`（工作空间管理器）
   - 将问题标识符映射到工作空间路径。
   - 确保每个问题的工作空间目录存在。
   - 运行工作空间生命周期钩子。
   - 清理终端状态问题的工作空间。

6. `Agent Runner`（智能体运行器）
   - 创建工作空间。
   - 根据问题 + 工作流模板构建提示词。
   - 启动编码智能体应用服务器客户端。
   - 将智能体更新流回编排器。

7. `Status Surface`（状态界面，可选）
   - 呈现人类可读的运行时状态（例如终端输出、仪表板或其他面向操作员的视图）。

8. `Logging`（日志）
   - 向一个或多个配置的接收器发出结构化运行时日志。

### 3.2 抽象层级

Symphony 在保持以下层级时最容易移植：

1. `Policy Layer`（策略层，由仓库定义）
   - `WORKFLOW.md` 提示词正文。
   - 针对票据处理、验证和移交的团队特定规则。

2. `Configuration Layer`（配置层，类型化 Getter）
   - 将前置内容解析为类型化的运行时设置。
   - 处理默认值、环境变量令牌和路径归一化。

3. `Coordination Layer`（协调层，编排器）
   - 轮询循环、问题符合条件判定、并发控制、重试、状态同步。

4. `Execution Layer`（执行层，工作空间 + 智能体子进程）
   - 文件系统生命周期、工作空间准备、编码智能体协议。

5. `Integration Layer`（集成层，Linear 适配器）
   - API 调用和追踪器数据的归一化。

6. `Observability Layer`（观测层，日志 + 可选的状态界面）
   - 操作员对编排器和智能体行为的可视化。

### 3.3 外部依赖

- 问题追踪器 API（在此规范版本中，`tracker.kind: linear` 为 Linear）。
- 用于工作空间和日志的本地文件系统。
- 可选的工作空间填充工具（例如 Git CLI，如果使用）。
- 支持通过标准输入输出进行类 JSON-RPC 应用服务器模式的编码智能体可执行文件。
- 用于问题追踪器和编码智能体的主机环境身份验证。

## 4. 核心领域模型

### 4.1 实体

#### 4.1.1 Issue（问题）

用于编排、提示词渲染和观测输出的归一化问题记录。

字段：

- `id` (string)
  - 稳定的追踪器内部 ID。
- `identifier` (string)
  - 人类可读的票据键（例如：`ABC-123`）。
- `title` (string)
- `description` (string 或 null)
- `priority` (integer 或 null)
  - 数字越小，在分发排序中优先级越高。
- `state` (string)
  - 当前追踪器状态名称。
- `branch_name` (string 或 null)
  - 追踪器提供的分支元数据（如果可用）。
- `url` (string 或 null)
- `labels` (字符串列表)
  - 归一化为小写。
- `blocked_by` (阻塞者引用列表)
  - 每个阻塞者引用包含：
    - `id` (string 或 null)
    - `identifier` (string 或 null)
    - `state` (string 或 null)
- `created_at` (时间戳 或 null)
- `updated_at` (时间戳 或 null)

#### 4.1.2 Workflow Definition（工作流定义）

解析后的 `WORKFLOW.md` 负载：

- `config` (map)
  - YAML 前置内容根对象。
- `prompt_template` (string)
  - 前置内容后的 Markdown 正文，已修剪。

#### 4.1.3 Service Config (Typed View)（服务配置，类型化视图）

源自 `WorkflowDefinition.config` 并结合环境解析的类型化运行时值。

示例：

- 轮询间隔
- 工作空间根目录
- 活跃和终端问题状态
- 并发限制
- 编码智能体可执行文件/参数/超时
- 工作空间钩子

#### 4.1.4 Workspace（工作空间）

分配给一个问题标识符的文件系统工作空间。

字段（逻辑上）：

- `path`（工作空间路径；当前运行时通常使用绝对路径，但如果配置时不带路径分隔符，也允许相对根路径）
- `workspace_key`（净化后的问题标识符）
- `created_now` (boolean，用于触发 `after_create` 钩子)

#### 4.1.5 Run Attempt（运行尝试）

对一个问题的一次执行尝试。

字段（逻辑上）：

- `issue_id`
- `issue_identifier`
- `attempt` (integer 或 null，第一次运行为 `null`，重试/继续运行则 `>=1`)
- `workspace_path`
- `started_at`
- `status`
- `error`（可选）

#### 4.1.6 Live Session (Agent Session Metadata)（活跃会话，智能体会话元数据）

编码智能体子进程运行时追踪的状态。

字段：

- `session_id` (string, `<thread_id>-<turn_id>`)
- `thread_id` (string)
- `turn_id` (string)
- `codex_app_server_pid` (string 或 null)
- `last_codex_event` (string/enum 或 null)
- `last_codex_timestamp` (时间戳 或 null)
- `last_codex_message`（总结后的负载）
- `codex_input_tokens` (integer)
- `codex_output_tokens` (integer)
- `codex_total_tokens` (integer)
- `last_reported_input_tokens` (integer)
- `last_reported_output_tokens` (integer)
- `last_reported_total_tokens` (integer)
- `turn_count` (integer)
  - 在当前工作器生命周期内开始的编码智能体轮次数量。

#### 4.1.7 Retry Entry（重试条目）

为问题安排的重试状态。

字段：

- `issue_id`
- `identifier`（用于状态界面/日志的最佳努力人类 ID）
- `attempt` (integer，重试队列中从 1 开始)
- `due_at_ms`（单调时钟时间戳）
- `timer_handle`（运行时特定的定时器引用）
- `error` (string 或 null)

#### 4.1.8 Orchestrator Runtime State（编排器运行时状态）

编排器拥有的单一权威内存状态。

字段：

- `poll_interval_ms`（当前有效轮询间隔）
- `max_concurrent_agents`（当前有效全局并发限制）
- `running` (map `issue_id -> running entry`)
- `claimed`（已预留/运行中/重试中的问题 ID 集合）
- `retry_attempts` (map `issue_id -> RetryEntry`)
- `completed`（问题 ID 集合；仅用于记账，不用于分发限制）
- `codex_totals`（聚合的 Token + 运行时秒数）
- `codex_rate_limits`（来自智能体事件的最新速率限制快照）

### 4.2 稳定标识符与归一化规则

- `Issue ID`
  - 用于追踪器查找和内部 Map 键。
- `Issue Identifier`
  - 用于人类可读的日志和工作空间命名。
- `Workspace Key`
  - 源自 `issue.identifier`，将任何不在 `[A-Za-z0-9._-]` 中的字符替换为 `_`。
  - 使用净化后的值作为工作空间目录名称。
- `Normalized Issue State`（归一化问题状态）
  - 在 `lowercase` 后进行状态比较。
- `Session ID`
  - 由编码智能体的 `thread_id` 和 `turn_id` 组合成 `<thread_id>-<turn_id>`。

## 5. 工作流规范（代码仓库契约）

### 5.1 文件发现与路径解析

工作流文件路径优先级：

1. 显式的应用/运行时设置（由 CLI 启动路径设置）。
2. 默认值：当前进程工作目录中的 `WORKFLOW.md`。

加载器行为：

- 如果文件无法读取，返回 `missing_workflow_file` 错误。
- 预期工作流文件由代码仓库拥有并受版本控制。

### 5.2 文件格式

`WORKFLOW.md` 是一个带有可选 YAML 前置内容的 Markdown 文件。

设计说明：

- `WORKFLOW.md` 应该足够自包含，以描述和运行不同的工作流（提示词、运行时设置、钩子以及追踪器选择/配置），而不需要带外的服务特定配置。

解析规则：

- 如果文件以 `---` 开始，解析直到下一个 `---` 之间的行为 YAML 前置内容。
- 剩余行成为提示词正文。
- 如果没有前置内容，将整个文件视为提示词正文，并使用空的配置 Map。
- YAML 前置内容必须解码为 Map/对象；非 Map 的 YAML 是错误。
- 提示词正文在使用前被修剪（trim）。

返回的工作流对象：

- `config`：前置内容根对象（不嵌套在 `config` 键下）。
- `prompt_template`：修剪后的 Markdown 正文。

### 5.3 前置内容模式（Schema）

顶层键：

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex`

为了向前兼容，应忽略未知键。

注意：

- 工作流前置内容是可扩展的。可选扩展可以定义额外的顶层键（例如 `server`），而无需更改上述核心模式。
- 扩展应记录其字段模式、默认值、验证规则，以及更改是动态应用还是需要重启。
- 常见扩展：`server.port` (integer) 启用第 13.7 节中描述的可选 HTTP 服务器。

#### 5.3.1 `tracker` (对象)

字段：

- `kind` (string)
  - 分发所需。
  - 当前支持的值：`linear`
- `endpoint` (string)
  - `tracker.kind == "linear"` 的默认值：`https://api.linear.app/graphql`
- `api_key` (string)
  - 可以是字面量令牌或 `$VAR_NAME`。
- `tracker.kind == "linear"` 的规范环境变量：`LINEAR_API_KEY`。
  - 如果 `$VAR_NAME` 解析为空字符串，则视为密钥缺失。
- `project_slug` (string)
  - 当 `tracker.kind == "linear"` 时分发所需。
- `active_states` (字符串列表)
  - 默认值：`Todo`, `In Progress`
- `terminal_states` (字符串列表)
  - 默认值：`Closed`, `Cancelled`, `Canceled`, `Duplicate`, `Done`

#### 5.3.2 `polling` (对象)

字段：

- `interval_ms` (integer 或 string integer)
  - 默认值：`30000`
  - 更改应在运行时重新应用，并在不重启的情况下影响未来的时钟调度。

#### 5.3.3 `workspace` (对象)

字段：

- `root` (路径字符串 或 `$VAR`)
  - 默认值：`<system-temp>/symphony_workspaces`
  - `~` 和包含路径分隔符的字符串将被展开。
  - 不带路径分隔符的原始字符串按原样保留（允许但建议不使用相对根路径）。

#### 5.3.4 `hooks` (对象)

字段：

- `after_create`（多行 Shell 脚本字符串，可选）
  - 仅在新建工作空间目录时运行。
  - 失败将中止工作空间的创建。
- `before_run`（多行 Shell 脚本字符串，可选）
  - 在准备好工作空间后、启动编码智能体之前的每次智能体尝试前运行。
  - 失败将中止当前尝试。
- `after_run`（多行 Shell 脚本字符串，可选）
  - 在工作空间存在的情况下，每次智能体尝试（成功、失败、超时或取消）后运行。
  - 失败会被记录但忽略。
- `before_remove`（多行 Shell 脚本字符串，可选）
  - 如果目录存在，在删除工作空间之前运行。
  - 失败会被记录但忽略；清理仍将继续。
- `timeout_ms` (integer，可选)
  - 默认值：`60000`
  - 适用于所有工作空间钩子。
  - 非正值应被视为无效并回退到默认值。
  - 更改应在运行时重新应用，用于未来的钩子执行。

#### 5.3.5 `agent` (对象)

字段：

- `max_concurrent_agents` (integer 或 string integer)
  - 默认值：`10`
  - 更改应在运行时重新应用，并影响随后的分发决策。
- `max_retry_backoff_ms` (integer 或 string integer)
  - 默认值：`300000`（5 分钟）
  - 更改应在运行时重新应用，并影响未来的重试调度。
- `max_concurrent_agents_by_state` (map `state_name -> positive integer`)
  - 默认值：空 Map。
  - 状态键在查找时会被归一化（`lowercase`）。
  - 无效条目（非正数或非数字）将被忽略。

#### 5.3.6 `codex` (对象)

字段：

对于 Codex 拥有的配置值（如 `approval_policy`、`thread_sandbox` 和 `turn_sandbox_policy`），支持的值由目标 Codex 应用服务器版本定义。实现者应将它们视为透传的 Codex 配置值，而不是依赖于本规范中手动维护的枚举。要检查安装的 Codex 架构，请运行 `codex app-server generate-json-schema --out <dir>` 并检查 `v2/ThreadStartParams.json` 和 `v2/TurnStartParams.json` 引用的相关定义。如果实现想要更严格的启动检查，可以在本地验证这些字段。

- `command`（字符串形式的 Shell 命令）
  - 默认值：`codex app-server`
  - 运行时在工作空间目录中通过 `bash -lc` 启动此命令。
  - 启动的进程必须通过标准输入输出使用兼容的应用服务器协议通信。
- `approval_policy` (Codex `AskForApproval` 值)
  - 默认值：由实现定义。
- `thread_sandbox` (Codex `SandboxMode` 值)
  - 默认值：由实现定义。
- `turn_sandbox_policy` (Codex `SandboxPolicy` 值)
  - 默认值：由实现定义。
- `turn_timeout_ms` (integer)
  - 默认值：`3600000`（1 小时）
- `read_timeout_ms` (integer)
  - 默认值：`5000`
- `stall_timeout_ms` (integer)
  - 默认值：`300000`（5 分钟）
  - 如果 `<= 0`，则禁用停滞检测。

### 5.4 提示词模板契约

`WORKFLOW.md` 的 Markdown 正文是每个问题的提示词模板。

渲染要求：

- 使用严格的模板引擎（Liquid 兼容的语义已足够）。
- 未知变量必须导致渲染失败。
- 未知过滤器必须导致渲染失败。

模板输入变量：

- `issue` (对象)
  - 包含所有归一化的问题字段，包括标签和阻塞者。
- `attempt` (integer 或 null)
  - 第一次尝试时为 `null`/缺失。
  - 重试或继续运行时为整数。

回退提示词行为：

- 如果工作流提示词正文为空，运行时可以使用最小化的默认提示词（`You are working on an issue from Linear.`）。
- 工作流文件读取/解析失败属于配置/验证错误，不应默默回退到默认提示词。

### 5.5 工作流验证与错误界面

错误类别：

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error`（在提示词渲染期间）
- `template_render_error`（未知变量/过滤器，无效插值）

分发限制行为：

- 工作流文件读取/YAML 错误会阻止新的分发，直到修复。
- 模板错误仅导致受影响的运行尝试失败。

## 6. 配置规范

### 6.1 来源优先级与解析语义

配置优先级：

1. 工作流文件路径选择（运行时设置 -> 当前工作目录默认值）。
2. YAML 前置内容值。
3. 所选 YAML 值中通过 `$VAR_NAME` 进行的环境变量间接引用。
4. 内置默认值。

值强制转换语义：

- 路径/命令字段支持：
  - `~` 家目录展开
  - `$VAR` 为环境变量支持的路径值进行展开
  - 仅对旨在作为本地文件系统路径的值应用展开；不要重写 URI 或任意 Shell 命令字符串。

### 6.2 动态重载语义

需要动态重载：

- 软件应监视 `WORKFLOW.md` 的更改。
- 发生更改时，它应在不重启的情况下重新读取并重新应用工作流配置和提示词模板。
- 软件应尝试将活跃行为调整为新配置（例如轮询节奏、并发限制、活跃/终端状态、Codex 设置、工作空间路径/钩子，以及未来运行的提示词内容）。
- 重载后的配置适用于未来的分发、重试调度、状态同步决策、钩子执行和智能体启动。
- 实现不要求在配置更改时自动重启正在进行的智能体会话。
- 管理自己监听器/资源（例如 HTTP 服务器端口更改）的扩展可能需要重启，除非实现明确支持动态重绑定。
- 实现还应在运行时操作期间（例如分发前）防御性地重新验证/重载，以防错过文件系统监视事件。
- 无效的重载不应导致服务崩溃；继续使用最后已知的良好有效配置运行，并发出操作员可见的错误。

### 6.3 分发预检验证

此验证是在尝试分发新工作之前的调度器预检。它验证轮询和启动工作器所需的工作流/配置，而不是对所有可能的工作流行为进行全面审核。

启动验证：

- 在开始调度循环之前验证配置。
- 如果启动验证失败，中止启动并发出操作员可见的错误。

每周期分发验证：

- 在每个分发周期前重新验证。
- 如果验证失败，跳过该周期的分发，保持状态同步活跃，并发出操作员可见的错误。

验证检查项：

- 工作流文件可以加载和解析。
- `tracker.kind` 存在且受支持。
- `tracker.api_key` 在 `$` 解析后存在。
- `tracker.project_slug` 在所选追踪器类型要求时存在。
- `codex.command` 存在且不为空。

### 6.4 配置字段摘要（速查表）

本节内容是有意重复的，以便编码智能体可以快速实现配置层。

- `tracker.kind`: 字符串，必填，当前为 `linear`
- `tracker.endpoint`: 字符串，当 `tracker.kind=linear` 时默认为 `https://api.linear.app/graphql`
- `tracker.api_key`: 字符串或 `$VAR`，当 `tracker.kind=linear` 时规范环境变量为 `LINEAR_API_KEY`
- `tracker.project_slug`: 字符串，当 `tracker.kind=linear` 时必填
- `tracker.active_states`: 字符串列表，默认为 `["Todo", "In Progress"]`
- `tracker.terminal_states`: 字符串列表，默认为 `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`
- `polling.interval_ms`: 整数，默认 `30000`
- `workspace.root`: 路径，默认 `<system-temp>/symphony_workspaces`
- `hooks.after_create`: Shell 脚本或 null
- `hooks.before_run`: Shell 脚本或 null
- `hooks.after_run`: Shell 脚本或 null
- `hooks.before_remove`: Shell 脚本或 null
- `hooks.timeout_ms`: 整数，默认 `60000`
- `agent.max_concurrent_agents`: 整数，默认 `10`
- `agent.max_turns`: 整数，默认 `20`
- `agent.max_retry_backoff_ms`: 整数，默认 `300000` (5m)
- `agent.max_concurrent_agents_by_state`: 正整数映射，默认 `{}`
- `codex.command`: Shell 命令字符串，默认 `codex app-server`
- `codex.approval_policy`: Codex `AskForApproval` 值，默认由实现定义
- `codex.thread_sandbox`: Codex `SandboxMode` 值，默认由实现定义
- `codex.turn_sandbox_policy`: Codex `SandboxPolicy` 值，默认由实现定义
- `codex.turn_timeout_ms`: 整数，默认 `3600000`
- `codex.read_timeout_ms`: 整数，默认 `5000`
- `codex.stall_timeout_ms`: 整数，默认 `300000`
- `server.port` (扩展): 整数，可选；启用可选的 HTTP 服务器，`0` 可用于临时本地绑定，CLI `--port` 会覆盖它

## 7. 编排状态机

编排器是唯一变动调度状态的组件。所有工作器结果都报告给它，并转换为显式的状态转换。

### 7.1 问题编排状态

这与追踪器状态（`Todo`、`In Progress` 等）不同。这是服务内部的占用状态。

1. `Unclaimed`（未占用）
   - 问题未在运行，也没有安排重试。

2. `Claimed`（已占用）
   - 编排器已预留该问题以防止重复分发。
   - 实际上，已占用的问题要么是 `Running`，要么是 `RetryQueued`。

3. `Running`（运行中）
   - 工作器任务存在，且问题追踪在 `running` 映射中。

4. `RetryQueued`（等待重试）
   - 工作器未运行，但 `retry_attempts` 中存在重试定时器。

5. `Released`（已释放）
   - 占用被移除，因为问题已进入终端状态、非活跃、缺失，或重试路径在未重新分发的情况下完成。

重要细微差别：

- 工作器成功退出并不意味着该问题永远完成了。
- 工作器在退出前可能会连续执行多个编码智能体轮次。
- 在每个正常的轮次完成后，工作器重新检查追踪器中的问题状态。
- 如果问题仍处于活跃状态，工作器应在同一个活跃的编码智能体线程中、同一个工作空间内开始另一轮，最多到 `agent.max_turns`。
- 第一轮应使用完整渲染的任务提示词。
- 后续轮次应仅向现有线程发送继续执行的指导，而不是重新发送线程历史中已存在的原始任务提示词。
- 工作器正常退出后，编排器仍会安排一个短时间的继续重试（约 1 秒），以便重新检查该问题是否保持活跃并需要另一个工作器会话。

### 7.2 运行尝试生命周期

运行尝试会经历以下阶段：

1. `PreparingWorkspace`（准备工作空间）
2. `BuildingPrompt`（构建提示词）
3. `LaunchingAgentProcess`（启动智能体进程）
4. `InitializingSession`（初始化会话）
5. `StreamingTurn`（轮次流式传输中）
6. `Finishing`（结束中）
7. `Succeeded`（成功）
8. `Failed`（失败）
9. `TimedOut`（超时）
10. `Stalled`（停滞）
11. `CanceledByReconciliation`（因状态同步取消）

区分不同的终端原因是重要的，因为重试逻辑和日志会有所不同。

### 7.3 转换触发器

- `Poll Tick`（轮询周期）
  - 同步活跃运行状态。
  - 验证配置。
  - 获取候选问题。
  - 分发任务直到槽位耗尽。

- `Worker Exit (normal)`（工作器退出（正常））
  - 移除运行条目。
  - 更新聚合运行总计。
  - 在工作器耗尽或完成其进程内轮次循环后，安排继续重试（尝试 `1`）。

- `Worker Exit (abnormal)`（工作器退出（异常））
  - 移除运行条目。
  - 更新聚合运行总计。
  - 安排指数退避重试。

- `Codex Update Event` (Codex 更新事件)
  - 更新活跃会话字段、Token 计数器和速率限制。

- `Retry Timer Fired`（重试定时器触发）
  - 重新获取活跃候选任务并尝试重新分发，如果不再符合条件则释放占用。

- `Reconciliation State Refresh`（状态同步刷新）
  - 停止那些问题状态已变为终端或不再活跃的运行。

- `Stall Timeout`（停滞超时）
  - 杀死工作器并安排重试。

### 7.4 幂等性与恢复规则

- 编排器通过单一权威机构序列化状态变更，以避免重复分发。
- 在启动任何工作器之前，必须进行 `claimed` 和 `running` 检查。
- 状态同步在每个周期的分发之前运行。
- 重启恢复是由追踪器驱动和文件系统驱动的（不需要持久化的编排器数据库）。
- 启动时的终端清理会移除已处于终端状态问题的陈旧工作空间。

## 8. 轮询、调度与状态同步

### 8.1 轮询循环

启动时，服务验证配置、执行启动清理、安排立即执行一个周期，然后每隔 `polling.interval_ms` 重复一次。

当重新应用工作流配置更改时，应更新有效的轮询间隔。

周期序列：

1. 同步正在运行的问题状态。
2. 运行分发预检验证。
3. 使用活跃状态从追踪器获取候选问题。
4. 按分发优先级对问题进行排序。
5. 在槽位剩余的情况下分发符合条件的问题。
6. 通知观测能力/状态消费者状态变更。

如果每周期验证失败，该周期将跳过分发，但状态同步仍会先发生。

### 8.2 候选选择规则

仅当满足以下所有条件时，问题才符合分发条件：

- 具有 `id`、`identifier`、`title` 和 `state`。
- 其状态在 `active_states` 中且不在 `terminal_states` 中。
- 尚未在 `running` 中。
- 尚未在 `claimed` 中。
- 全局并发槽位可用。
- 每个状态的并发槽位可用。
- `Todo` 状态的阻塞规则通过：
  - 如果问题状态为 `Todo`，当任何阻塞者处于非终端状态时，不进行分发。

排序顺序（稳定意图）：

1. `priority` 升序（优先 1..4；null/未知排在最后）
2. `created_at` 最早优先
3. `identifier` 词典顺序作为决胜局

### 8.3 并发控制

全局限制：

- `available_slots = max(max_concurrent_agents - running_count, 0)`

每状态限制：

- 如果存在，使用 `max_concurrent_agents_by_state[state]`（状态键已归一化）
- 否则回退到全局限制

运行时根据 `running` 映射中当前的追踪状态对问题进行计数。

### 8.4 重试与退避

重试条目创建：

- 取消针对同一问题的任何现有重试定时器。
- 存储 `attempt`、`identifier`、`error`、`due_at_ms` 和新的定时器句柄。

退避公式：

- 工作器干净退出后的正常继续重试使用 `1000` ms 的短固定延迟。
- 故障驱动的重试使用 `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`。
- 乘方受配置的最大重试退避限制（默认 `300000` / 5m）。

重试处理行为：

1. 获取活跃候选问题（并非所有问题）。
2. 通过 `issue_id` 查找特定问题。
3. 如果未找到，释放占用。
4. 如果找到且仍符合候选条件：
   - 如果槽位可用，则分发。
   - 否则以错误 `no available orchestrator slots` 重新排队。
5. 如果找到但不再活跃，释放占用。

注意：

- 终端状态工作空间清理由启动清理和活跃运行状态同步（包括当前运行问题的终端转换）处理。
- 重试处理主要操作活跃候选任务，并在问题缺失时释放占用，而不是由其自身执行终端清理。

### 8.5 活跃运行状态同步

状态同步在每个周期运行，包含两部分。

A 部分：停滞检测

- 对于每个运行中的问题，计算自以下情况以来的 `elapsed_ms`：
  - 如果已看到任何事件，则为 `last_codex_timestamp`，否则为
  - `started_at`
- 如果 `elapsed_ms > codex.stall_timeout_ms`，终止工作器并排队重试。
- 如果 `stall_timeout_ms <= 0`，则完全跳过停滞检测。

B 部分：追踪器状态刷新

- 为所有运行中的问题 ID 获取当前问题状态。
- 对于每个运行中的问题：
  - 如果追踪器状态为终端：终止工作器并清理工作空间。
  - 如果追踪器状态仍为活跃：更新内存中的问题快照。
  - 如果追踪器状态既非活跃也非终端：在不清理工作空间的情况下终止工作器。
- 如果状态刷新失败，保持工作器运行并在下一个周期重试。

### 8.6 启动终端工作空间清理

当服务启动时：

1. 查询追踪器中处于终端状态的问题。
2. 对于每个返回的问题标识符，移除相应的工作空间目录。
3. 如果终端问题获取失败，记录警告并继续启动。

这可以防止重启后陈旧的终端工作空间累积。

## 9. 工作空间管理与安全

### 9.1 工作空间布局

工作空间根目录：

- `workspace.root`（归一化后的路径；当前配置层展开类似路径的值并保留原始相对名称）

每个问题的工作空间路径：

- `<workspace.root>/<sanitized_issue_identifier>`

工作空间持久性：

- 工作空间跨同一问题的多次运行而重用。
- 成功的运行不会自动删除工作空间。

### 9.2 工作空间创建与重用

输入：`issue.identifier`

算法总结：

1. 将标识符净化为 `workspace_key`。
2. 计算工作空间根目录下的工作空间路径。
3. 确保工作空间路径作为目录存在。
4. 仅当在此次调用期间新建目录时，标记 `created_now=true`；否则 `created_now=false`。
5. 如果 `created_now=true`，且配置了 `after_create` 钩子，则运行该钩子。

注意：

- 本节不假设任何特定的代码仓库/VCS 工作流。
- 除了创建目录之外的工作空间准备（例如依赖项引导、检出/同步、代码生成）是由实现定义的，通常通过钩子处理。

### 9.3 可选的工作空间填充（由实现定义）

本规范不要求任何内置的 VCS 或仓库引导行为。

实现可以使用实现定义的逻辑和/或钩子（例如 `after_create` 和/或 `before_run`）来填充或同步工作空间。

失败处理：

- 工作空间填充/同步失败将返回当前尝试的错误。
- 如果在创建全新工作空间时发生失败，实现可以移除部分准备好的目录。
- 除非明确选择并记录了该策略，否则重用的工作空间不应在填充失败时被破坏性重置。

### 9.4 工作空间钩子

支持的钩子：

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

执行契约：

- 在适合主机操作系统的本地 Shell 上下文中执行，工作空间目录作为 `cwd`。
- 在 POSIX 系统上，`sh -lc <script>`（或更严格的等效项，如 `bash -lc <script>`）是符合规范的默认值。
- 钩子超时使用 `hooks.timeout_ms`；默认值：`60000 ms`。
- 记录钩子开始、失败和超时。

失败语义：

- `after_create` 失败或超时对工作空间创建是致命的。
- `before_run` 失败或超时对当前运行尝试是致命的。
- `after_run` 失败或超时会被记录并忽略。
- `before_remove` 失败或超时会被记录并忽略。

### 9.5 安全不变性

这是最重要的移植性约束。

不变性 1：仅在每个问题的工作空间路径中运行编码智能体。

- 在启动编码智能体子进程之前，验证：
  - `cwd == workspace_path`

不变性 2：工作空间路径必须保留在工作空间根目录内。

- 将两个路径都归一化为绝对路径。
- 要求 `workspace_path` 将 `workspace_root` 作为前缀目录。
- 拒绝工作空间根目录之外的任何路径。

不变性 3：工作空间键已净化。

- 工作空间目录名称仅允许 `[A-Za-z0-9._-]`。
- 将所有其他字符替换为 `_`。

## 10. 智能体运行器协议（编码智能体集成）

本节定义了集成编码智能体应用服务器的与语言无关的契约。

兼容性概况：

- 规范契约包括消息顺序、所需行为以及必须提取的逻辑字段（例如会话 ID、完成状态、审批处理以及使用量/速率限制遥测）。
- 确切的 JSON 字段名称在兼容的应用服务器版本之间可能略有不同。
- 实现应容忍带有相同逻辑含义的等效负载形状，特别是针对嵌套 ID、审批请求、需要用户输入的信号，以及 Token/速率限制元数据。

### 10.1 启动契约

子进程启动参数：

- 命令：`codex.command`
- 调用：`bash -lc <codex.command>`
- 工作目录：工作空间路径
- 标准输出/错误：分离的流
- 分帧：标准输出上的行分隔协议消息（每行一个类似 JSON-RPC 的 JSON）

注意：

- 默认命令是 `codex app-server`。
- 审批策略、cwd 和提示词在第 10.2 节的协议消息中表达。

建议的其他进程设置：

- 最大行大小：10 MB（用于安全缓冲）

### 10.2 会话启动握手

参考：https://developers.openai.com/codex/app-server/

客户端必须按顺序发送这些协议消息：

说明性启动脚本（如果保留相同的语义，等效的负载形状也是可以接受的）：

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"symphony","version":"1.0"},"capabilities":{}}}
{"method":"initialized","params":{}}
{"id":2,"method":"thread/start","params":{"approvalPolicy":"<implementation-defined>","sandbox":"<implementation-defined>","cwd":"/abs/workspace"}}
{"id":3,"method":"turn/start","params":{"threadId":"<thread-id>","input":[{"type":"text","text":"<rendered prompt-or-continuation-guidance>"}],"cwd":"/abs/workspace","title":"ABC-123: Example","approvalPolicy":"<implementation-defined>","sandboxPolicy":{"type":"<implementation-defined>"}}}
```

1. `initialize` 请求
   - 参数包括：
     - `clientInfo` 对象（例如 `{name, version}`）
     - `capabilities` 对象（可以为空）
   - 如果目标 Codex 应用服务器需要针对动态工具进行能力协商，请在此包含必要的能力标志。
   - 等待响应 (`read_timeout_ms`)
2. `initialized` 通知
3. `thread/start` 请求
   - 参数包括：
     - `approvalPolicy` = 实现定义的会话审批策略值
     - `sandbox` = 实现定义的会话沙箱值
     - `cwd` = 绝对工作空间路径
     - 如果实现了可选的客户端工具，请使用目标 Codex 应用服务器版本支持的协议机制包含它们通告的工具规范。
4. `turn/start` 请求
   - 参数包括：
     - `threadId`
     - `input` = 包含第一轮渲染后的提示词或后续轮次继续执行指导的单个文本项
     - `cwd`
     - `title` = `<issue.identifier>: <issue.title>`
     - `approvalPolicy` = 实现定义的轮次审批策略值
     - `sandboxPolicy` = 目标应用服务器版本要求时的对象形式沙箱策略负载

会话标识符：

- 从 `thread/start` 的结果 `result.thread.id` 中读取 `thread_id`
- 从每个 `turn/start` 的结果 `result.turn.id` 中读取 `turn_id`
- 发出 `session_id = "<thread_id>-<turn_id>"`
- 在一次工作器运行中，所有后续轮次重复使用同一个 `thread_id`

### 10.3 流式轮次处理

客户端读取行分隔的消息，直到轮次终止。

完成条件：

- `turn/completed` -> 成功
- `turn/failed` -> 失败
- `turn/cancelled` -> 失败
- 轮次超时 (`turn_timeout_ms`) -> 失败
- 子进程退出 -> 失败

后续处理：

- 如果工作器决定在成功的一轮后继续，它应在同一个活跃的 `threadId` 上发起另一个 `turn/start`。
- 应用服务器子进程应在这些后续轮次中保持存活，并仅在工作器运行结束时停止。

行处理要求：

- 仅从标准输出读取协议消息。
- 缓冲部分标准输出行，直到换行符到达。
- 在完整的标准输出行上尝试 JSON 解析。
- 标准错误不是协议流的一部分：
  - 忽略它或将其记录为诊断信息
  - 不要尝试对标准错误进行协议 JSON 解析

### 10.4 发出的运行时事件（从下游到编排器）

应用服务器客户端向编排器回调发出结构化事件。每个事件应包含：

- `event` (enum/string)
- `timestamp` (UTC 时间戳)
- `codex_app_server_pid`（如果可用）
- 可选的 `usage` 映射（Token 计数）
- 根据需要的负载字段

发出的重要事件可能包括：

- `session_started`
- `startup_failed`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`
- `turn_ended_with_error`
- `turn_input_required`
- `approval_auto_approved`
- `unsupported_tool_call`
- `notification`
- `other_message`
- `malformed`

### 10.5 审批、工具调用与用户输入策略

审批、沙箱和用户输入行为是由实现定义的。

策略要求：

- 每个实现应记录其选择的审批、沙箱和操作员确认态势。
- 审批请求和需要用户输入的事件不得让运行无限期停滞。实现应满足它们、将它们呈现给操作员、自动解决它们，或者根据其记录的策略使运行失败。

示例高信任行为：

- 自动批准会话的命令执行审批。
- 自动批准会话的文件更改审批。
- 将需要用户输入的轮次视为硬性失败。

不受支持的动态工具调用：

- 由运行时明确实现和通告的受支持动态工具调用，应根据其扩展契约进行处理。
- 如果智能体请求了一个不受支持的动态工具调用 (`item/tool/call`)，返回工具失败响应并继续会话。
- 这可以防止会话在不受支持的工具执行路径上停滞。

可选的客户端工具扩展：

- 实现可以向应用服务器会话暴露一组有限的客户端工具。
- 当前可选的标准化工具：`linear_graphql`。
- 如果实现，受支持的工具应在启动期间使用目标 Codex 应用服务器版本支持的协议机制通告给应用服务器会话。
- 不受支持的工具名称仍应返回失败结果并继续会话。

`linear_graphql` 扩展契约：

- 目的：使用 Symphony 为当前会话配置的追踪器身份验证对 Linear 执行原始 GraphQL 查询或变更（mutation）。
- 可用性：仅在 `tracker.kind == "linear"` 且配置了有效的 Linear 身份验证时有意义。
- 首选输入形状：

  ```json
  {
    "query": "单个 GraphQL 查询或变更文档",
    "variables": {
      "optional": "GraphQL 变量对象"
    }
  }
  ```

- `query` 必须是非空字符串。
- `query` 必须包含恰好一个 GraphQL 操作。
- `variables` 是可选的，如果存在，必须是一个 JSON 对象。
- 实现还可以接受原始 GraphQL 查询字符串作为简写输入。
- 每个工具调用执行一个 GraphQL 操作。
- 如果提供的文档包含多个操作，拒绝该工具调用为无效输入。
- `operationName` 选择有意超出此扩展的范围。
- 重用来自活跃 Symphony 工作流/运行时配置的已配置 Linear 端点和身份验证；不要要求编码智能体从磁盘读取原始令牌。
- 工具结果语义：
  - 传输成功 + 没有顶层 GraphQL `errors` -> `success=true`
  - 存在顶层 GraphQL `errors` -> `success=false`，但保留 GraphQL 响应体用于调试
  - 无效输入、缺少身份验证或传输失败 -> `success=false` 并带有错误负载
- 将 GraphQL 响应或错误负载作为结构化工具输出返回，模型可以在会话中检查。

说明性响应（如果保留相同的结果，等效的负载形状也是可以接受的）：

```json
{"id":"<approval-id>","result":{"approved":true}}
{"id":"<tool-call-id>","result":{"success":false,"error":"unsupported_tool_call"}}
```

对用户输入要求的硬性失败：

- 如果智能体请求用户输入，立即使运行尝试失败。
- 客户端通过以下方式检测：
  - 显式方法 (`item/tool/requestUserInput`)，或
  - 指示需要输入的轮次方法/标志。

### 10.6 超时与错误映射

超时：

- `codex.read_timeout_ms`：启动和同步请求期间的请求/响应超时
- `codex.turn_timeout_ms`：总计轮次流超时
- `codex.stall_timeout_ms`：由编排器根据事件非活跃状态强制执行

错误映射（建议的归一化类别）：

- `codex_not_found`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `port_exit`
- `response_error`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required`

### 10.7 智能体运行器契约

`Agent Runner` 封装了工作空间 + 提示词 + 应用服务器客户端。

行为：

1. 为问题创建/重用工作空间。
2. 根据工作流模板构建提示词。
3. 启动应用服务器会话。
4. 将应用服务器事件转发给编排器。
5. 发生任何错误时，使工作器尝试失败（编排器将重试）。

注意：

- 工作空间在成功运行后会有意保留。

## 11. 问题追踪器集成契约（Linear 兼容）

### 11.1 所需操作

实现必须支持以下追踪器适配器操作：

1. `fetch_candidate_issues()`
   - 为配置的项目返回处于配置的活跃状态的问题。

2. `fetch_issues_by_states(state_names)`
   - 用于启动时的终端清理。

3. `fetch_issue_states_by_ids(issue_ids)`
   - 用于活跃运行的状态同步。

### 11.2 查询语义 (Linear)

针对 `tracker.kind == "linear"` 的 Linear 特定要求：

- `tracker.kind == "linear"`
- GraphQL 端点（默认 `https://api.linear.app/graphql`）
- 在 `Authorization` 标头中发送身份验证令牌
- `tracker.project_slug` 映射到 Linear 项目的 `slugId`
- 候选问题查询使用 `project: { slugId: { eq: $projectSlug } }` 过滤项目
- 问题状态刷新查询使用带有变量类型 `[ID!]` 的 GraphQL 问题 ID
- 候选问题需要分页
- 默认页面大小：`50`
- 网络超时：`30000 ms`

重要：

- Linear GraphQL 模式详情可能会发生变化。保持查询构造代码的隔离，并测试本规范所需的具体查询字段/类型。

非 Linear 实现可以更改传输详情，但归一化输出必须与第 4 节中的领域模型匹配。

### 11.3 归一化规则

候选问题归一化应产生第 4.1.1 节中列出的字段。

其他归一化详情：

- `labels` -> 小写字符串
- `blocked_by` -> 源自关系类型为 `blocks` 的逆向关系
- `priority` -> 仅整数（非整数变为 null）
- `created_at` 和 `updated_at` -> 解析 ISO-8601 时间戳

### 11.4 错误处理契约

建议的错误类别：

- `unsupported_tracker_kind`
- `missing_tracker_api_key`
- `missing_tracker_project_slug`
- `linear_api_request`（传输失败）
- `linear_api_status`（非 200 HTTP）
- `linear_graphql_errors`
- `linear_unknown_payload`
- `linear_missing_end_cursor`（分页完整性错误）

编排器在追踪器错误时的行为：

- 候选任务获取失败：记录日志并跳过此周期的分发。
- 运行状态刷新失败：记录日志并保持活跃的工作器继续运行。
- 启动时的终端清理失败：记录警告日志并继续启动。

### 11.5 追踪器写入（重要边界）

Symphony 不要求编排器中具备一等公民的追踪器写入 API。

- 票据变动（状态转换、评论、PR 元数据）通常由编码智能体使用工作流提示词定义的工具处理。
- 服务保持作为调度器/运行器和追踪器读取器的角色。
- 特定于工作流的成功通常意味着“达到下一个移交状态”（例如 `Human Review`），而不是追踪器终端状态 `Done`。
- 如果实现了可选的 `linear_graphql` 客户端工具扩展，它仍然是智能体工具链的一部分，而不是编排器业务逻辑。

## 12. 提示词构造与上下文组装

### 12.1 输入

提示词渲染的输入：

- `workflow.prompt_template`
- 归一化后的 `issue` 对象
- 可选的 `attempt` 整数（重试/后续运行元数据）

### 12.2 渲染规则

- 使用严格的变量检查进行渲染。
- 使用严格的过滤器检查进行渲染。
- 将问题对象键转换为字符串以实现模板兼容性。
- 保留嵌套数组/映射（标签、阻塞者），以便模板可以迭代。

### 12.3 重试/后续运行语义

应将 `attempt` 传递给模板，因为工作流提示词可能针对以下情况提供不同的指令：

- 第一次运行（`attempt` 为 null 或缺失）
- 成功会话后的后续运行
- 发生错误/超时/停滞后的重试

### 12.4 失败语义

如果提示词渲染失败：

- 立即使运行尝试失败。
- 让编排器像对待任何其他工作器失败一样处理，并决定重试行为。

## 13. 日志、状态与观测能力

### 13.1 日志约定

问题相关日志所需的上下文字段：

- `issue_id`
- `issue_identifier`

编码智能体会话生命周期日志所需的上下文字段：

- `session_id`

消息格式要求：

- 使用稳定的 `key=value` 措辞。
- 包含操作结果（`completed`、`failed`、`retrying` 等）。
- 存在时包含简洁的失败原因。
- 除非必要，避免记录大型原始负载。

### 13.2 日志输出与接收器

本规范不规定日志必须去往何处（标准错误、文件、远程接收器等）。

要求：

- 操作员必须能够在不附加调试器的情况下看到启动/验证/分发失败。
- 实现可以向一个或多个接收器写入。
- 如果配置的日志接收器失败，服务应在可能的情况下继续运行，并通过任何剩余的接收器发出操作员可见的警告。

### 13.3 运行时快照 / 监控接口（可选但建议）

如果实现暴露了同步运行时快照（用于仪表板或监控），它应返回：

- `running`（正在运行的会话行列表）
- 每个运行行应包含 `turn_count`
- `retrying`（重试队列行列表）
- `codex_totals`
  - `input_tokens`
  - `output_tokens`
  - `total_tokens`
  - `seconds_running`（截至快照时间的聚合运行秒数，包括活跃会话）
- `rate_limits`（如果可用，最新的编码智能体速率限制负载）

建议的快照错误模式：

- `timeout`
- `unavailable`

### 13.4 可选的人类可读状态界面

人类可读的状态界面（终端输出、仪表板等）是可选的且由实现定义。

如果存在，它应仅从编排器状态/指标提取数据，且不得为正确性所必需。

### 13.5 会话指标与 Token 记账

Token 记账规则：

- 智能体事件可能在多个负载形状中包含 Token 计数。
- 当可用时，首选绝对的线程总数，例如：
  - `thread/tokenUsage/updated` 负载
  - Token 计数封装事件中的 `total_token_usage`
- 针对仪表板/API 总数，忽略增量样式的负载，如 `last_token_usage`。
- 从所选负载内的常用字段名中宽容地提取输入/输出/总计 Token 计数。
- 对于绝对总数，追踪相对于上次报告总数的增量，以避免重复计算。
- 不要将通用的 `usage` 映射视为累积总数，除非事件类型以此方式定义它们。
- 在编排器状态中累加聚合总数。

运行时间记账：

- 运行时间应在快照/渲染时报告为实时聚合值。
- 实现可以为已结束的会话维护一个累积计数器，并在生成快照/状态视图时加上源自 `running` 条目（例如 `started_at`）的活跃会话已用时间。
- 当会话结束（正常退出或取消/终止）时，将运行持续时间秒数加到累积的已结束会话运行时间中。
- 不要求对运行时间总计进行持续的后台计时。

速率限制追踪：

- 追踪在任何智能体更新中看到的最新速率限制负载。
- 速率限制数据的任何人类可读呈现是由实现定义的。

### 13.6 人性化的智能体事件总结（可选）

对原始智能体协议事件的人性化总结是可选的。

如果实现：

- 仅将它们视为观测输出。
- 不要让编排器逻辑依赖于人性化字符串。

### 13.7 可选的 HTTP 服务器扩展

本节定义了一个用于观测能力和操作控制的可选 HTTP 接口。

如果实现：

- HTTP 服务器是一个扩展，对于一致性不是必需的。
- 实现可以为仪表板提供服务器渲染的 HTML 或客户端应用程序。
- 仪表板/API 必须仅作为观测/控制界面，且不得成为编排器正确性的必需项。

启用（扩展）：

- 当提供 CLI `--port` 参数时启动 HTTP 服务器。
- 当 `WORKFLOW.md` 前置内容中存在 `server.port` 时启动 HTTP 服务器。
- `server.port` 是扩展配置，有意不作为第 5.3 节中核心前置内容模式的一部分。
- 优先级：当两者都存在时，CLI `--port` 覆盖 `server.port`。
- `server.port` 必须是整数。正值绑定该端口。`0` 可用于为本地开发和测试请求临时端口。
- 除非另有明确配置，实现应默认绑定回环地址（`127.0.0.1` 或主机等效项）。
- HTTP 监听器设置的更改（例如 `server.port`）不需要热重绑定；需要重启的行为是符合规范的。

#### 13.7.1 人类可读仪表板 (`/`)

- 在 `/` 托管一个人类可读的仪表板。
- 返回的文档应描绘系统的当前状态（例如活跃会话、重试延迟、Token 消耗、运行时间总计、最近事件以及健康/错误指标）。
- 由实现决定这是服务器生成的 HTML 还是消费下方 JSON API 的客户端应用。

#### 13.7.2 JSON REST API (`/api/v1/*`)

在 `/api/v1/*` 下提供 JSON REST API，用于当前运行时状态和操作调试。

最小端点：

- `GET /api/v1/state`
  - 返回当前系统状态的摘要视图（运行中的会话、重试队列/延迟、聚合 Token/运行时间总计、最新的速率限制以及任何其他追踪的摘要字段）。
  - 建议的响应形状：

    ```json
    {
      "generated_at": "2026-02-24T20:15:30Z",
      "counts": {
        "running": 2,
        "retrying": 1
      },
      "running": [
        {
          "issue_id": "abc123",
          "issue_identifier": "MT-649",
          "state": "In Progress",
          "session_id": "thread-1-turn-1",
          "turn_count": 7,
          "last_event": "turn_completed",
          "last_message": "",
          "started_at": "2026-02-24T20:10:12Z",
          "last_event_at": "2026-02-24T20:14:59Z",
          "tokens": {
            "input_tokens": 1200,
            "output_tokens": 800,
            "total_tokens": 2000
          }
        }
      ],
      "retrying": [
        {
          "issue_id": "def456",
          "issue_identifier": "MT-650",
          "attempt": 3,
          "due_at": "2026-02-24T20:16:00Z",
          "error": "no available orchestrator slots"
        }
      ],
      "codex_totals": {
        "input_tokens": 5000,
        "output_tokens": 2400,
        "total_tokens": 7400,
        "seconds_running": 1834.2
      },
      "rate_limits": null
    }
    ```

- `GET /api/v1/<issue_identifier>`
  - 为标识的问题返回特定于问题的运行时/调试详情，包括实现追踪的对调试有用的任何信息。
  - 建议的响应形状：

    ```json
    {
      "issue_identifier": "MT-649",
      "issue_id": "abc123",
      "status": "running",
      "workspace": {
        "path": "/tmp/symphony_workspaces/MT-649"
      },
      "attempts": {
        "restart_count": 1,
        "current_retry_attempt": 2
      },
      "running": {
        "session_id": "thread-1-turn-1",
        "turn_count": 7,
        "state": "In Progress",
        "started_at": "2026-02-24T20:10:12Z",
        "last_event": "notification",
        "last_message": "Working on tests",
        "last_event_at": "2026-02-24T20:14:59Z",
        "tokens": {
          "input_tokens": 1200,
          "output_tokens": 800,
          "total_tokens": 2000
        }
      },
      "retry": null,
      "logs": {
        "codex_session_logs": [
          {
            "label": "latest",
            "path": "/var/log/symphony/codex/MT-649/latest.log",
            "url": null
          }
        ]
      },
      "recent_events": [
        {
          "at": "2026-02-24T20:14:59Z",
          "event": "notification",
          "message": "Working on tests"
        }
      ],
      "last_error": null,
      "tracked": {}
    }
    ```

  - 如果问题对当前内存状态是未知的，返回 `404` 并带有错误响应（例如 `{\"error\":{\"code\":\"issue_not_found\",\"message\":\"...\"}}`）。

- `POST /api/v1/refresh`
  - 排队一个立即执行的追踪器轮询 + 状态同步周期（最佳努力触发；实现可以合并重复的请求）。
  - 建议的请求体：空体或 `{}`。
  - 建议的响应 (`202 Accepted`) 形状：

    ```json
    {
      "queued": true,
      "coalesced": false,
      "requested_at": "2026-02-24T20:15:30Z",
      "operations": ["poll", "reconcile"]
    }
    ```

API 设计说明：

- 上述 JSON 形状是实现互操作性和调试人机工程学的推荐基准。
- 实现可以添加字段，但应避免在同一版本内破坏现有字段。
- 除了操作触发器（如 `/refresh`）外，端点应为只读。
- 定义路由上不受支持的方法应返回 `405 Method Not Allowed`。
- API 错误应使用 JSON 信封，如 `{"error":{"code":"...","message":"..."}}`。
- 如果仪表板是客户端应用，它应消费此 API 而不是复制状态逻辑。

## 14. 故障模型与恢复策略

### 14.1 故障类别

1. `Workflow/Config Failures`（工作流/配置故障）
   - `WORKFLOW.md` 缺失
   - YAML 前置内容无效
   - 不受支持的追踪器类型或缺失追踪器凭据/项目 slug
   - 编码智能体可执行文件缺失

2. `Workspace Failures`（工作空间故障）
   - 工作空间目录创建失败
   - 工作空间填充/同步失败（由实现定义；可能来自钩子）
   - 无效的工作空间路径配置
   - 钩子超时/失败

3. `Agent Session Failures`（智能体会话故障）
   - 启动握手失败
   - 轮次失败/取消
   - 轮次超时
   - 请求用户输入（硬性失败）
   - 子进程退出
   - 会话停滞（无活动）

4. `Tracker Failures`（追踪器故障）
   - API 传输错误
   - 非 200 状态
   - GraphQL 错误
   - 格式错误的负载

5. `Observability Failures`（观测能力故障）
   - 快照超时
   - 仪表板渲染错误
   - 日志接收器配置失败

### 14.2 恢复行为

- 分发验证失败：
  - 跳过新的分发。
  - 保持服务存活。
  - 在可能的情况下继续状态同步。

- 工作器故障：
  - 转换为带有指数退避的重试。

- 追踪器候选获取失败：
  - 跳过此周期。
  - 在下一个周期重试。

- 状态同步刷新失败：
  - 保留当前工作器。
  - 在下一个周期重试。

- 仪表板/日志失败：
  - 不要让编排器崩溃。

### 14.3 部分状态恢复（重启）

当前设计对调度器状态是有意内存化的。

重启后：

- 不会从先前的进程内存恢复重试定时器。
- 不假设运行中的会话是可恢复的。
- 服务通过以下方式恢复：
  - 启动时的终端工作空间清理
  - 对活跃问题的全新轮询
  - 重新分发符合条件的工作

### 14.4 操作员干预点

操作员可以通过以下方式控制行为：

- 编辑 `WORKFLOW.md`（提示词和大多数运行时设置）。
- 应自动检测并重新应用 `WORKFLOW.md` 的更改，无需重启。
- 在追踪器中更改问题状态：
  - 终端状态 -> 同步时停止运行中的会话并清理工作空间
  - 非活跃状态 -> 停止运行中的会话，不进行清理
- 重启服务进行进程恢复或部署（不作为应用工作流配置更改的常规路径）。

## 15. 安全与操作安全

### 15.1 信任边界假设

每个实现定义其自己的信任边界。

操作安全要求：

- 实现应明确说明其是旨在用于受信任环境、更受限的环境，还是两者兼而有之。
- 实现应明确说明其是依赖于自动批准的操作、操作员审批、更严格的沙箱，还是这些控制的某种组合。
- 工作空间隔离和路径验证是重要的基准控制，但它们不能替代实现选择的任何审批和沙箱策略。

### 15.2 文件系统安全要求

强制性：

- 工作空间路径必须保持在配置的工作空间根目录之下。
- 编码智能体的当前工作目录（cwd）必须是当前运行的每个问题工作空间路径。
- 工作空间目录名称必须使用净化后的标识符。

建议针对端口进行的额外加固：

- 在专用的操作系统用户下运行。
- 限制工作空间根目录的权限。
- 如果可能，将工作空间根目录挂载在专用卷上。

### 15.3 密钥处理

- 在工作流配置中支持 `$VAR` 间接引用。
- 不要记录 API 令牌或敏感的环境变量值。
- 在不打印密钥的情况下验证其存在。

### 15.4 钩子脚本安全

工作空间钩子是来自 `WORKFLOW.md` 的任意 Shell 脚本。

影响：

- 钩子是完全受信任的配置。
- 钩子在工作空间目录内运行。
- 钩子输出应在日志中截断。
- 为了避免挂起编排器，需要设置钩子超时。

### 15.5 线束（Harness）加固指南

针对可能包含敏感数据或外部控制内容的代码仓库、问题追踪器和其他输入运行 Codex 智能体可能是危险的。如果诱导智能体执行有害命令或使用过于强大的集成，宽松的部署可能导致数据泄露、破坏性变动或完全的机器受损。

实现应明确评估其自身的风险状况，并在适当情况下加固执行线束。本规范有意不强制要求单一的加固态势，但各版本不应假设追踪器数据、仓库内容、提示词输入或工具参数是完全可信的，仅仅因为它们起源于正常的工作流内部。

可能的加固措施包括：

- 收紧本规范中其他地方描述的 Codex 审批和沙箱设置，而不是以最大许可配置运行。
- 添加外部隔离层，如操作系统/容器/VM 沙箱、网络限制，或除了内置 Codex 策略控制之外的独立凭据。
- 过滤哪些 Linear 问题、项目、团队、标签或其他追踪器来源符合分发条件，以便不受信任或超出范围的任务不会自动到达智能体。
- 缩小可选的 `linear_graphql` 工具，使其仅能在预期的项目范围内读取或变动数据，而不是暴露通用的工作空间范围内的追踪器访问权限。
- 将智能体可用的客户端工具、凭据、文件系统路径和网络目的地集合减少到工作流所需的最小值。

正确的控制措施取决于具体的部署，但实现应清楚地记录它们，并将线束加固视为核心安全模型的一部分，而不是可选的后续想法。

## 16. 参考算法（与语言无关）

### 16.1 服务启动

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    codex_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    codex_rate_limits: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 16.2 轮询并分发周期

```text
on_tick(state):
  state = reconcile_running_issues(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  issues = tracker.fetch_candidate_issues()
  if issues failed:
    log_tracker_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for issue in sort_for_dispatch(issues):
    if no_available_slots(state):
      break

    if should_dispatch(issue, state):
      state = dispatch_issue(issue, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 16.3 活跃运行状态同步

```text
function reconcile_running_issues(state):
  state = reconcile_stalled_runs(state)

  running_ids = keys(state.running)
  if running_ids is empty:
    return state

  refreshed = tracker.fetch_issue_states_by_ids(running_ids)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for issue in refreshed:
    if issue.state in terminal_states:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=true)
    else if issue.state in active_states:
      state.running[issue.id].issue = issue
    else:
      state = terminate_running_issue(state, issue.id, cleanup_workspace=false)

  return state
```

### 16.4 分发单个问题

```text
function dispatch_issue(issue, state, attempt):
  worker = spawn_worker(
    fn -> run_agent_attempt(issue, attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    return schedule_retry(state, issue.id, next_attempt(attempt), {
      identifier: issue.identifier,
      error: "failed to spawn agent"
    })

  state.running[issue.id] = {
    worker_handle,
    monitor_handle,
    identifier: issue.identifier,
    issue,
    session_id: null,
    codex_app_server_pid: null,
    last_codex_message: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(issue.id)
  state.retry_attempts.remove(issue.id)
  return state
```

### 16.5 工作器尝试（工作空间 + 提示词 + 智能体）

```text
function run_agent_attempt(issue, attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_issue(issue.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  session = app_server.start_session(workspace=workspace.path)
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    prompt = build_turn_prompt(workflow_template, issue, attempt, turn_number, max_turns)
    if prompt failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = app_server.run_turn(
      session=session,
      prompt=prompt,
      issue=issue,
      on_message=(msg) -> send(orchestrator_channel, {codex_update, issue.id, msg})
    )

    if turn_result failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("agent turn error")

    refreshed_issue = tracker.fetch_issue_states_by_ids([issue.id])
    if refreshed_issue failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")

    issue = refreshed_issue[0] or issue

    if issue.state is not active:
      break

    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  app_server.stop_session(session)
  run_hook_best_effort("after_run", workspace.path)

  exit_normal()
```

### 16.6 工作器退出与重试处理

```text
on_worker_exit(issue_id, reason, state):
  running_entry = state.running.remove(issue_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(issue_id)  # 仅用于记账
    state = schedule_retry(state, issue_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry(state, issue_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason")
    })

  notify_observers()
  return state
```

```text
on_retry_timer(issue_id, state):
  retry_entry = state.retry_attempts.pop(issue_id)
  if missing:
    return state

  candidates = tracker.fetch_candidate_issues()
  if fetch failed:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  issue = find_by_id(candidates, issue_id)
  if issue is null:
    state.claimed.remove(issue_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, issue_id, retry_entry.attempt + 1, {
      identifier: issue.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_issue(issue, state, attempt=retry_entry.attempt)
```

## 17. 测试与验证矩阵

符合规范的实现应包含覆盖本规范定义的行为的测试。

验证概览：

- `Core Conformance`（核心一致性）：所有符合规范的实现都需要的确定性测试。
- `Extension Conformance`（扩展一致性）：仅对实现选择提供的可选功能要求。
- `Real Integration Profile`（真实集成概况）：建议在生产使用前进行的依赖环境的冒烟/集成检查。

除非另有说明，第 17.1 至 17.7 节均为 `Core Conformance`。以 `If ... is implemented` 开头的条目属于 `Extension Conformance`。

### 17.1 工作流与配置解析

- 工作流文件路径优先级：
  - 提供显式运行时路径时使用该路径
  - 未提供显式运行时路径时，当前工作目录默认值为 `WORKFLOW.md`
- 检测到工作流文件更改，并在不重启的情况下触发重新读取/重新应用
- 无效的工作流重载保留最后已知的良好有效配置，并发出操作员可见的错误
- 缺失 `WORKFLOW.md` 返回类型化错误
- 无效的 YAML 前置内容返回类型化错误
- 前置内容非 Map 返回类型化错误
- 缺失可选值时应用配置默认值
- `tracker.kind` 验证强制执行当前受支持的类型 (`linear`)
- `tracker.api_key` 工作正常（包括 `$VAR` 间接引用）
- `$VAR` 解析对追踪器 API 密钥和路径值工作正常
- `~` 路径展开工作正常
- `codex.command` 作为 Shell 命令字符串被保留
- 每状态并发覆盖映射会归一化状态名称并忽略无效值
- 提示词模板渲染 `issue` 和 `attempt`
- 提示词渲染在遇到未知变量时失败（严格模式）

### 17.2 工作空间管理器与安全

- 每个问题标识符对应确定性的工作空间路径
- 创建缺失的工作空间目录
- 重用现有的工作空间目录
- 安全处理工作空间位置处现有的非目录路径（根据实现策略替换或失败）
- 暴露可选的工作空间填充/同步错误
- 在准备期间移除临时产物 (`tmp`, `.elixir_ls`)
- `after_create` 钩子仅在新建工作空间时运行
- `before_run` 钩子在每次尝试前运行，失败/超时将中止当前尝试
- `after_run` 钩子在每次尝试后运行，失败/超时会被记录并忽略
- `before_remove` 钩子在清理时运行，失败/超时被忽略
- 在智能体启动前强制执行工作空间路径净化和根目录包含不变性
- 智能体启动使用每个问题的工作空间路径作为 cwd，并拒绝根目录以外的路径

### 17.3 问题追踪器客户端

- 候选问题获取使用活跃状态和项目 slug
- Linear 查询使用指定的项目过滤字段 (`slugId`)
- 空的 `fetch_issues_by_states([])` 在不进行 API 调用时返回空结果
- 分页在多个页面之间保留顺序
- 阻塞者从类型为 `blocks` 的逆向关系中归一化
- 标签归一化为小写
- 通过 ID 进行的问题状态刷新返回最小化的归一化问题
- 如第 11.2 节所规定，问题状态刷新查询使用 GraphQL ID 类型 (`[ID!]`)
- 针对请求错误、非 200 状态、GraphQL 错误、格式错误的负载的错误映射

### 17.4 编排器分发、状态同步与重试

- 分发排序顺序为优先级，然后是最早创建时间
- 带有非终端阻塞者的 `Todo` 问题不符合条件
- 带有终端阻塞者的 `Todo` 问题符合条件
- 活跃状态问题刷新会更新运行条目状态
- 非活跃状态会在不清理工作空间的情况下停止运行中的智能体
- 终端状态会停止运行中的智能体并清理工作空间
- 没有运行中问题时的状态同步是空操作
- 工作器正常退出会安排短时间的继续重试（尝试 1）
- 工作器异常退出会以 10 秒为基准进行指数退避重试
- 退避上限使用配置的 `agent.max_retry_backoff_ms`
- 重试队列条目包含尝试次数、到期时间、标识符和错误
- 停滞检测会杀死停滞的会话并安排重试
- 槽位耗尽会以显式的错误原因重新排队重试
- 如果实现了快照 API，它会返回运行行、重试行、Token 总计和速率限制
- 如果实现了快照 API，会显现超时/不可用情况

### 17.5 编码智能体应用服务器客户端

- 启动命令使用工作空间 cwd 并调用 `bash -lc <codex.command>`
- 启动握手发送 `initialize`、`initialized`、`thread/start`、`turn/start`
- `initialize` 包含目标 Codex 应用服务器协议要求的客户端标识/能力负载
- 策略相关的启动负载使用实现记录的审批/沙箱设置
- `thread/start` 和 `turn/start` 解析嵌套 ID 并发出 `session_started`
- 强制执行请求/响应读取超时
- 强制执行轮次超时
- 缓冲部分 JSON 行直到换行符
- 标准输出和标准错误分别处理；仅从标准输出解析协议 JSON
- 非 JSON 格式的标准错误行会被记录，但不会导致解析崩溃
- 命令/文件更改审批根据实现记录的策略处理
- 不受支持的动态工具调用在不让会话停滞的情况下被拒绝
- 用户输入请求根据实现记录的策略处理，且不会无限期停滞
- 从嵌套负载形状中提取使用量和速率限制负载
- 当保留相同的逻辑含义时，接受审批、需要用户输入信号以及使用量/速率限制遥测的兼容负载变体
- 如果实现了可选的客户端工具，启动握手会通告目标应用服务器版本发现所需的受支持工具规范
- 如果实现了可选的 `linear_graphql` 客户端工具扩展：
  - 工具被通告给会话
  - 有效的 `query` / `variables` 输入针对配置的 Linear 身份验证执行
  - 顶层 GraphQL `errors` 产生 `success=false`，同时保留 GraphQL 正文
  - 无效参数、缺失身份验证和传输失败返回结构化失败负载
  - 不受支持的工具名称仍会在不让会话停滞的情况下失败

### 17.6 观测能力

- 验证失败对操作员可见
- 结构化日志包含问题/会话上下文字段
- 日志接收器失败不会导致编排崩溃
- Token/速率限制聚合在重复的智能体更新中保持正确
- 如果实现了人类可读的状态界面，它由编排器状态驱动，且不影响正确性
- 如果实现了人性化的事件总结，它们覆盖核心封装器/智能体事件类别，且不改变编排器行为

### 17.7 CLI 与主机生命周期

- CLI 接受一个可选的位置参数：工作流路径 (`path-to-WORKFLOW.md`)
- 未提供工作流路径参数时，CLI 使用 `./WORKFLOW.md`
- 当显式的工作流路径不存在或缺失默认的 `./WORKFLOW.md` 时，CLI 报错
- CLI 清晰地呈现启动失败
- 当应用程序启动并正常关闭时，CLI 以成功状态退出
- 当启动失败或主机进程异常退出时，CLI 以非零状态退出

### 17.8 真实集成概况（建议）

建议这些检查以实现生产就绪，在凭据、网络访问或外部服务权限不可用时，可以在 CI 中跳过。

- 可以使用由 `LINEAR_API_KEY` 或记录的本地引导机制（例如 `~/.linear_api_key`）提供的有效凭据运行真实的追踪器冒烟测试。
- 真实的集成测试应使用隔离的测试标识符/工作空间，并在可行时清理追踪器产物。
- 跳过的真实集成测试应报告为已跳过，而不是默默视为通过。
- 如果在 CI 或发布验证中明确启用了真实集成概览，失败应导致该任务失败。

## 18. 实现检查清单 (完成定义)

使用与第 17 节相同的验证概览：

- 第 18.1 节 = `Core Conformance`
- 第 18.2 节 = `Extension Conformance`
- 第 18.3 节 = `Real Integration Profile`

### 18.1 一致性要求

- 工作流路径选择支持显式运行时路径和当前工作目录默认值
- `WORKFLOW.md` 加载器具有 YAML 前置内容 + 提示词正文拆分功能
- 类型化配置层，具有默认值和 `$` 解析功能
- 对配置和提示词进行动态 `WORKFLOW.md` 监视/重载/重新应用
- 具有单一权威可变状态的轮询编排器
- 问题追踪器客户端，具有候选获取 + 状态刷新 + 终端获取功能
- 工作空间管理器，具有净化后的每个问题工作空间
- 工作空间生命周期钩子 (`after_create`, `before_run`, `after_run`, `before_remove`)
- 钩子超时配置 (`hooks.timeout_ms`, 默认 `60000`)
- 具有 JSON 行协议的编码智能体应用服务器子进程客户端
- Codex 启动命令配置 (`codex.command`, 默认 `codex app-server`)
- 带有 `issue` 和 `attempt` 变量的严格提示词渲染
- 在正常退出后进行继续重试的指数重试队列
- 可配置的重试退避上限 (`agent.max_retry_backoff_ms`, 默认 5m)
- 状态同步在终端/非活跃追踪器状态时停止运行
- 终端问题的工作空间清理（启动清理 + 活跃状态转换）
- 带有 `issue_id`、`issue_identifier` 和 `session_id` 的结构化日志
- 操作员可见的观测能力（结构化日志；可选的快照/状态界面）

### 18.2 建议的扩展（一致性非必需）

- 可选的 HTTP 服务器如果发布，应遵循 CLI `--port` 优于 `server.port` 的原则，使用安全的默认绑定主机，并暴露第 13.7 节中的基准端点/错误语义。
- 可选的 `linear_graphql` 客户端工具扩展通过应用服务器会话暴露使用配置的 Symphony 身份验证的原始 Linear GraphQL 访问权限。
- TODO: 跨进程重启持久化重试队列和会话元数据。
- TODO: 使观测设置在工作流前置内容中可配置，而不规定 UI 实现细节。
- TODO: 在编排器中添加一等的追踪器写入 API（评论/状态转换），而不仅是通过智能体工具。
- TODO: 添加 Linear 以外的可插拔问题追踪器适配器。

### 18.3 生产前的操作验证（建议）

- 使用有效的凭据和网络访问运行第 17.8 节中的 `Real Integration Profile`。
- 在目标主机操作系统/Shell 环境中验证钩子执行和工作流路径解析。
- 如果发布了可选的 HTTP 服务器，在目标环境中验证配置的端口行为以及回环/默认绑定预期。
