/**
 * Shown when a side chat's forked thread is gone.
 *
 * Codex's fork is ephemeral — it lives in the app-server's memory and is never
 * written to disk — so it cannot be resumed once that process is replaced. The
 * chat record survives with a thread id that no longer resolves, and this is
 * what the user sees instead of a raw protocol error.
 *
 * Providers whose forks are ordinary persisted sessions (Claude Code, OpenCode)
 * have no equivalent state and do not use this.
 */
export const SIDE_CHAT_EXPIRED_MESSAGE =
  'This side chat expired. Temporary side chats are lost when the agent restarts — open a new one to continue.'
