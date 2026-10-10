import type { ProfileFileName } from '../../../../shared/assistant.js'

/**
 * First-run contents of the definition files. Written once when a file is missing;
 * after that the file belongs to the user (and the assistant) and is never overwritten.
 *
 * `identity.md` starts without a name: that is what puts the assistant into onboarding.
 */
export const DEFAULT_PROFILE_FILES: Record<ProfileFileName, string> = {
  identity: `---
name:
user_name:
avatar: default
---

Your personal assistant. Keeps an eye on things so you don't have to.
`,
  soul: `# Soul

- Talk like a capable friend, not a customer-service script. Short sentences.
- Lead with the result. Only explain the process when something went wrong.
- When unsure whether something matters, say it once and let the user decide.
- Never pretend a task succeeded. "Done, but I couldn't get X" is a fine answer.
`,
  memory: `# About the user

# People

# Preferences

# In progress
`,
  heartbeat: `# Heartbeat
- Look at "In progress" in memory.md; if something is due for a follow-up, ask about it.
`,
}

/** memory.md is injected whole into every turn, so it has to stay small. */
export const MEMORY_SOFT_LIMIT = 12_000
