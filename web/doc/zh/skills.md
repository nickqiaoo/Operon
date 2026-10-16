# 技能

## 这是什么

技能是给 Agent 的专门指令包，比如审查设计或准备提交。它与[插件](plugins)是两回事；插件可以把技能和 MCP 服务器打包在一起。

## 工作原理

一个技能就是带有名字、简介和指令的 Markdown 文件（`SKILL.md`）。Agent 发现相关技能后，按需读取完整说明；支持情况取决于各 Agent 的技能约定。

技能可以安装到**全局**或**当前项目**。同名的项目技能优先于全局技能。技能详情会显示位置，以及哪些 Agent 能看到它。

## 怎么用

### 浏览与安装

1. 打开 **Settings > Skills**。
2. 选择 **Global** 或当前项目范围。
3. 浏览已安装和可用技能、按名称搜索，或加载 GitHub 来源（默认 `vercel-labs/agent-skills`）。
4. 打开技能阅读内容，有相应操作时可用 **Install** 或 **Update**。新开对话以使用更新后的指令。

### 卸载

在技能详情中移除已安装技能。标为插件提供的技能需要到 **Plugins** 管理，不能在这里直接删除。

### Agent 怎么用技能

你可以直接指定技能名称，也可以让 Agent 按请求选择。安装技能只是提供做法；执行仍需要相应的工具和权限。

### 自己写一个

创建带 YAML frontmatter 的 `SKILL.md`：

```markdown
---
name: my-skill
description: "A brief description of what this skill does"
---

Detailed instructions for the AI go here...
```

共享全局技能可放在 `~/.agents/skills/my-skill/SKILL.md`，项目技能可放在项目的 `.agents/skills/my-skill/SKILL.md`。在设置中查看 Agent 标记，确认它们是否发现了技能。
