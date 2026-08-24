# Skills

## What is it

Skills are pluggable instruction packs that give the AI agent specialized knowledge for specific tasks. Think of them as expert guides — when the AI encounters a task that matches a skill (e.g., web design review, code commit formatting), it loads the corresponding skill to get detailed, domain-specific instructions.

## How it works

Each skill is a Markdown file (`SKILL.md`) with a name, description, and detailed instructions. At the start of every chat session, the system injects a list of all available skills into the AI's context. When the AI determines that a user request matches a skill's description, it activates that skill by loading the full instructions on demand.

Skills are stored globally at `~/.agents/skills/` and managed via an underlying CLI tool. You can install skills from GitHub repositories or create your own.

## Usage

### Browsing & Installing

1. Go to the **Skills** page from the sidebar.
2. The **Installed** section shows skills currently active on your system.
3. The **Browse** section lets you search skills from a GitHub repository (default: `vercel-labs/agent-skills`).
4. Click **Install** to add a skill. It will be available in all future chat sessions.

### Uninstalling

Click the delete button on any installed skill to remove it.

### How the AI uses skills

You don't need to manually activate skills. The AI automatically detects when a skill is relevant to your request and loads it. For example, if you have a "web-design" skill installed and ask the AI to review your UI, it will activate that skill to provide expert-level feedback.

### Creating your own skills

Create a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: "A brief description of what this skill does"
---

Detailed instructions for the AI go here...
```

Place it at `~/.agents/skills/my-skill/SKILL.md`. It will be automatically discovered on the next chat session.
