/**
 * Claude Code switches Operon owns (Settings → Claude Code). Each is injected
 * into every Claude session as the environment variable that decides it, so it
 * wins over whatever the user's, project's or policy settings files say — what
 * the switch shows is what sessions run with.
 */
export interface ClaudeToggles {
  /** Predict the next prompt after each turn. Also keeps it on near the usage limit. */
  promptSuggestions: boolean
  /** Claude Code's auto memory. */
  autoMemory: boolean
}

/** Claude Code's own defaults, so turning nothing on changes nothing. */
export const DEFAULT_CLAUDE_TOGGLES: ClaudeToggles = {
  promptSuggestions: true,
  autoMemory: true,
}
