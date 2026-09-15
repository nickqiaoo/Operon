/**
 * Every provider the external-agent tool offers must have a sub-agent mode.
 *
 * `subagentMode()` throws for an unregistered provider by design, so a provider
 * added to the external-agent list but not to SUBAGENT_MODE is offered to the
 * model and then fails every call (grok/antigravity shipped that way).
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../ai.js', () => ({ getProviderModels: async () => ({}), getSessionManager: () => ({}) }))
vi.mock('../adapter/bundled-cli-paths.js', () => ({ isAdapterAvailable: () => true }))

const { SUPPORTED_EXTERNAL_AGENT_IDS } = await import('../../routes/external-agent-mcp.js')
const { subagentMode } = await import('./subagent-mode.js')

describe('subagentMode', () => {
  it.each([...SUPPORTED_EXTERNAL_AGENT_IDS])('registers a mode for external agent %s', (id) => {
    expect(() => subagentMode(id)).not.toThrow()
  })

  it('throws for an unregistered provider', () => {
    expect(() => subagentMode('not-a-provider')).toThrow(/No sub-agent permission mode/)
  })
})
