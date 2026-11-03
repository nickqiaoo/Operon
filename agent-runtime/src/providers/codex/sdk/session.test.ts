import { describe, expect, it, vi } from 'vitest'
import { AppServerClient } from './app-server-client.js'
import { SessionImpl } from './session.js'
import { toImageInput } from './converters/image-converter.js'

// App-server UserInput uses `url`; `imageUrl` belongs only to the public SDK.
// Keep this boundary covered separately from the runtime's message mapper.
describe('Codex image protocol', () => {
  it.each([
    'data:image/png;base64,iVBORw0KGgo=',
    'https://example.com/image.png',
  ])('maps SDK image URL %s to the wire field', (url) => {
    expect(toImageInput({ type: 'file', mediaType: 'image/png', data: new URL(url) }, [], []))
      .toEqual({ type: 'image', url })
  })

  it('maps an injected image to the same wire field', async () => {
    const client = new AppServerClient({})
    const startTurn = vi.spyOn(client, 'startTurn').mockResolvedValue({
      turn: { id: 'turn-1', status: 'inProgress', items: [], error: null },
    })
    const session = new SessionImpl(client, 'thread-1')
    const url = 'data:image/png;base64,iVBORw0KGgo='
    await session.injectMessage([{ type: 'image', imageUrl: url }])
    expect(startTurn).toHaveBeenCalledWith({
      threadId: 'thread-1', input: [{ type: 'image', url }],
    })
  })
})
