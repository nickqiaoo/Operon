# 记忆

## 这是什么

记忆让 AI 长期记住你和你的项目，省得你每开一个对话都要把同样的话再交代一遍——你的偏好、写代码的习惯、项目里定过的事，它换个会话也还记得。

## 工作原理

每条记忆都是一个 **page**，由 `(type, slug)` 唯一定位。每个 page 包含：

- **`truth`** —— 对该主题"当前最佳的理解"。每次写入都会**覆盖**它，不是追加。
- **`timeline`** —— 一份只追加的变更日志，每次 truth 变化都必须解释一句"为什么改"。

分成这两层的好处是：每个主题永远只有一份"现在的答案"，同时它一路是怎么变成这样的，也一条不落地留着。

Operon 通过 MCP 给 Agent 两个工具，聊天时它自己按需要调：

- **`memory_search`** —— 跨 page（truth + timeline）做混合检索。可以在一次调用里传多个 `types`。
- **`memory_upsert`** —— 通过 reconcile 流程写入。第一次提交 `content` 和 `reason`；如果存在相似 page，工具返回候选而不是直接写入。

### Slug resolver（候选回弹）

`memory_upsert` 不会对每个新的 `slug_hint` 都新建 page。写入前会先检查确定性身份命中（exact slug、规范化 slug、已学习 alias）和同 type 下的语义候选。如果存在候选，调用会返回 `status: "needs_reconcile"`，并带上候选的 `slug`、`truth`、`revision`。Agent 再次调用 `memory_upsert`，用 `decision.action = "merge"` 和完整合并后的 page `truth` 写回，或用 `decision.action = "create"` 确认这是一个真正的新 page。这样既不会让同一个主题散成好几页，也不会拿一条新事实把整页原有的内容盖掉。

### 单例类型

`profile` 和 `preferences` 强制单例：slug 永远是 `"user"`，每个用户只有一条 profile page 和一条 preferences page。这两种类型下 `slug_hint` 会被忽略。

### 存储

记忆存在 Operon 主 SQLite 库里（`memory_pages` / `memory_timeline` / `memory_timeline_fts` 三张表），外加一个本地 sqlite-vec 向量库。全部在本地完成，不会发给任何远端服务。

### 检索架构

`memory_search` 同时走**三条路**去找最相关的 page：

1. **Truth 关键词检索** —— SQLite FTS5 + BM25 覆盖每个 page 的 `truth`。
2. **Timeline 关键词检索** —— SQLite FTS5 + BM25 覆盖 `memory_timeline.entry`。
3. **向量语义检索** —— 本地嵌入模型（Qwen3-Embedding-0.6B）把 truth 切片和 timeline 条目转成 1024 维向量，存入本地 sqlite-vec 库，按余弦距离检索。

三路排序结果用 Reciprocal Rank Fusion（k=60）融合：`score(d) = Σ 1/(k + rank_i(d))`。融合后按 `(type, slug)` 聚合，使每个 page 只出现一次，按各自最高融合分排序。

## 记忆类别

- **Profile（个人档案）** *（单例）* —— 你是做什么的、擅长什么、什么背景。AI 据此把握该讲多深。
- **Preferences（偏好）** *（单例）* —— 你习惯怎么做事：代码风格、说话方式、顺手的工具。
- **Entities（实体）** —— 值得记住的人、项目、服务，以及其他有名有姓的东西。
- **Events（事件）** —— 定过的决策、出过的事故、要赶的时间点，这类跟时间有关的事。
- **Cases（案例）** —— 具体的问题和当时怎么解决的，反复遇到的问题尤其值得记。
- **Patterns（模式）** —— 反复用到的做法、架构上的取舍、这个代码库的惯例。

## 管理记忆

### 浏览

1. 进入 **Settings > Memory**。
2. 切到 **Memory** 子标签。
3. 每一行是一个 page，显示它的 type、slug 和 truth 的开头。展开就能看到这一页完整的 timeline。
4. 搜索栏可以对全部记忆做语义搜索。
5. 上面的分类按钮按 type 筛。

### 删除

删掉一个 page，它的 truth、所有 timeline 条目和对应的向量会一起清掉。在重新建起来之前，AI 不会再看到这个主题。

## 嵌入模型

语义搜索要用到一个本地的嵌入模型。

1. 进入 **Settings > Memory > Embedding**。
2. 下载嵌入模型（Qwen3-Embedding-0.6B）。
3. 有 GPU 就自动用 GPU，没有就退回 CPU。
4. 下完之后可以点测试按钮，确认模型能正常跑。

嵌入全部在本地算——记忆这块不会有任何数据离开你的电脑。
