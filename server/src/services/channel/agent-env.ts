import type { Agent } from '../../types/channel.js'

/**
 * Reduce an agent's stored env list to the plain Record the runtime expects,
 * dropping entries with no key or with `enabled: false`. The disabled entries
 * stay in the DB so the user can flip them back on without retyping.
 */
export function resolveAgentEnv(agent: Agent | { env?: Agent['env'] }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of agent.env ?? []) {
    if (!entry.enabled) continue
    const key = entry.key.trim()
    if (!key) continue
    out[key] = entry.value
  }
  return out
}
