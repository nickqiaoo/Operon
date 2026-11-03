import { vi } from 'vitest'
import type { SaasConfig } from '../src/gateway/saas/config.js'

// Tests must never read the developer's ~/.operon/saas.json or use its node
// token to send real phone pushes. Suites testing SaaS can supply their own mock.
vi.mock('../src/gateway/saas/config.js', () => {
  let config: SaasConfig = {}
  return {
    getSaasConfig: (): SaasConfig => config,
    setSaasConfig: (patch: Partial<SaasConfig>): SaasConfig => {
      config = { ...config, ...patch }
      return config
    },
    clearSaasConfig: () => { config = {} },
  }
})
