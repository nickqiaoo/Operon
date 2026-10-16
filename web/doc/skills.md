# Skills

## What is it

Skills are instruction packs that give agents specialized guidance for a task, such as reviewing a design or preparing a commit. They are separate from [Plugins](plugins), which can bundle skills together with MCP servers.

## How it works

A skill is a Markdown file (`SKILL.md`) with a name, description, and instructions. Agents discover relevant skills and load their full instructions when needed; support follows each agent's skill conventions.

Skills can be installed **globally** or for the **current project**. A project skill with the same name takes precedence over a global one. The skill detail shows its location and which agents can see it.

## Usage

### Browsing & Installing

1. Open **Settings > Skills**.
2. Choose **Global** or the current project scope.
3. Browse installed and available skills, search by name, or load a GitHub source (default: `vercel-labs/agent-skills`).
4. Open a skill to read it, then use **Install** or **Update** where offered. Start a new conversation to use the updated instructions.

### Uninstalling

Remove an installed skill from its detail view. Skills marked as provided by a plugin are managed from **Plugins**, rather than deleted here.

### How the AI uses skills

You can ask for a skill by name, or let the agent choose one that matches your request. Installing a skill supplies guidance; the agent still needs the tools and permissions required to carry it out.

### Creating your own skills

Create a `SKILL.md` with YAML frontmatter:

```markdown
---
name: my-skill
description: "A brief description of what this skill does"
---

Detailed instructions for the AI go here...
```

Use `~/.agents/skills/my-skill/SKILL.md` for a shared global skill, or `.agents/skills/my-skill/SKILL.md` in your project. Check the agent badges in Settings to confirm discovery.
