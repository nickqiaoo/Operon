import { afterEach, expect, it, vi } from 'vitest'
import { getSaasConfig } from '../gateway/saas/config.js'
import { relayPush } from './push-relay.js'

afterEach(() => { vi.unstubAllGlobals() })

it('keeps test approval notifications offline even on a signed-in developer machine', () => {
  const fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)

  expect(getSaasConfig()).toEqual({})
  relayPush({ severity: 'action', sourceKey: 'chat:test', title: 'Waiting for approval' })

  expect(fetchMock).not.toHaveBeenCalled()
})
