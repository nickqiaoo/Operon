import { describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '../context.js'
import { QoderRuntimeSession } from './qoder/session.js'

describe('native input delivery SDK boundaries', () => {
  it('uses Qoder next/later and rejects an idle warm query', async () => {
    const session = new QoderRuntimeSession({ cwd: '/tmp' }, createRuntimeContext({ resolveBinary: () => '/mock/qoder' }))
    const enqueue = vi.fn(), interrupt = vi.fn()
    Object.assign(session, { activeQuery: { interrupt }, inputQueue: { enqueue }, messageLoopDead: false, mcpReadyPromise: Promise.resolve() })
    await expect(session.followup('idle')).rejects.toThrow('No active')
    Object.assign(session, { turn: {} })
    await session.steer('next input'); await session.followup('later input')
    expect(enqueue.mock.calls.map(([message]) => message.priority)).toEqual(['next', 'later'])
    await session.followup([{ type: 'text', text: 'see image' }, { type: 'file', data: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }])
    expect(enqueue.mock.calls[2][0]).toMatchObject({ priority: 'later', message: { content: expect.arrayContaining([expect.objectContaining({ type: 'image' })]) } })
    expect(interrupt).not.toHaveBeenCalled()
  })
})
