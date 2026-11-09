import { describe, expect, it, vi } from 'vitest'
import { AppServerClient, CodexRpcError } from './app-server-client.js'
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
    const startTurn = vi.spyOn(client, 'steerTurn').mockResolvedValue({ turnId: 'turn-1' })
    const session = new SessionImpl(client, 'thread-1')
    session._setTurnId('turn-1')
    const url = 'data:image/png;base64,iVBORw0KGgo='
    await session.injectMessage([{ type: 'image', imageUrl: url }])
    expect(startTurn).toHaveBeenCalledWith({
      threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'image', url }],
    })
  })
})


describe('Codex strict steer', () => {
  it('never calls turn/start or starts an idle session', async () => {
    const client = new AppServerClient({}), start = vi.spyOn(client, 'startTurn'), steer = vi.spyOn(client, 'steerTurn')
    await expect(new SessionImpl(client, 'thread').injectMessage('idle')).rejects.toThrow('No active')
    expect(start).not.toHaveBeenCalled(); expect(steer).not.toHaveBeenCalled()
  })
  it('distinguishes a definite stale-turn rejection from an unknown transport failure', async () => {
    const client = new AppServerClient({}), session = new SessionImpl(client, 'thread')
    session._setTurnId('turn')
    const steer = vi.spyOn(client, 'steerTurn').mockRejectedValueOnce(new CodexRpcError('Expected turn is no longer active', -32600))
    const { RuntimeInjectionUnavailableError } = await import('../../../types.js')
    await expect(session.injectMessage('racing')).rejects.toBeInstanceOf(RuntimeInjectionUnavailableError)
    const unknown = new Error('connection closed after request')
    steer.mockRejectedValueOnce(unknown)
    await expect(session.injectMessage('unknown')).rejects.toBe(unknown)
  })
})
