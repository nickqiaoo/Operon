import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiRoutes } from './ai.js'
import { handleCCDynamicSet } from '../services/ai.js'

vi.mock('../services/ai.js', () => ({
  handleCCDynamicSet: vi.fn(async () => ({ success: true })),
}))

const storage = {} as Parameters<typeof aiRoutes>[0]

describe('POST /cc/dynamic-set', () => {
  beforeEach(() => {
    vi.mocked(handleCCDynamicSet).mockClear()
  })

  it.each(['fast', ''])('forwards an explicit Fast selection (%j)', async (serviceTier) => {
    const response = await aiRoutes(storage).request('/cc/dynamic-set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 42, serviceTier }),
    })

    expect(await response.json()).toEqual({ success: true })
    expect(handleCCDynamicSet).toHaveBeenCalledWith(42, expect.objectContaining({
      serviceTier: serviceTier === 'fast' ? 'fast' : undefined,
    }))
    expect(vi.mocked(handleCCDynamicSet).mock.calls[0][1]).toHaveProperty('serviceTier')
  })

  it('leaves Fast unchanged when only effort is selected', async () => {
    await aiRoutes(storage).request('/cc/dynamic-set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 42, thinkingLevel: 'max' }),
    })

    expect(handleCCDynamicSet).toHaveBeenCalledWith(42, expect.objectContaining({ effort: 'max' }))
    expect(vi.mocked(handleCCDynamicSet).mock.calls[0][1]).not.toHaveProperty('serviceTier')
  })
})
