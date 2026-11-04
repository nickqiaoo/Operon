// Operon's Claude Code switches (shared/claude-toggles.ts), stored in the KV
// store and applied to every Claude session as environment variables.
//
// An env var is the one layer above all of Claude Code's settings files, so
// injecting it makes the switch authoritative without reading or writing those
// files. Both states are injected: "off" must force off too, or a project file
// could turn the feature back on behind a switch that says otherwise.
//
// The variables join the session's `env`, which is part of the session's
// structural key — flipping a switch rebuilds a live Claude session on its next
// turn, so the change applies to open conversations as well.

import { DEFAULT_CLAUDE_TOGGLES, type ClaudeToggles } from '../../../shared/claude-toggles.js'
import type { StorageAdapter } from '../storage/interface.js'

const KV_KEY = 'claude:toggles'

let storage: StorageAdapter | null = null

export function initClaudeTogglesService(adapter: StorageAdapter): void {
  storage = adapter
}

export function getClaudeToggles(): ClaudeToggles {
  const saved = storage?.get<Partial<ClaudeToggles>>(KV_KEY) ?? {}
  return {
    promptSuggestions: typeof saved.promptSuggestions === 'boolean' ? saved.promptSuggestions : DEFAULT_CLAUDE_TOGGLES.promptSuggestions,
    autoMemory: typeof saved.autoMemory === 'boolean' ? saved.autoMemory : DEFAULT_CLAUDE_TOGGLES.autoMemory,
  }
}

export function setClaudeToggles(patch: Partial<ClaudeToggles>): ClaudeToggles {
  const next = { ...getClaudeToggles() }
  if (typeof patch.promptSuggestions === 'boolean') next.promptSuggestions = patch.promptSuggestions
  if (typeof patch.autoMemory === 'boolean') next.autoMemory = patch.autoMemory
  storage?.set(KV_KEY, next)
  return next
}

/** The variables a Claude session is started with. */
export function claudeToggleEnv(toggles: ClaudeToggles = getClaudeToggles()): Record<string, string> {
  return {
    // =1 also keeps suggestions on when the account nears its usage limit.
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: toggles.promptSuggestions ? '1' : '0',
    // DISABLE=0 forces auto memory on; =1 turns it off.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: toggles.autoMemory ? '0' : '1',
  }
}
