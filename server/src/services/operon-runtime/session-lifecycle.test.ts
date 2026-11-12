import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionAlreadyLoadingError, type Harness, type HarnessSession } from 'operon-agents'

const { observe } = vi.hoisted(() => ({ observe: vi.fn() }))
vi.mock('./passive-observer.js', () => ({ observeSession: observe }))
import { resumeRuntimeSession } from './session-lifecycle.js'

beforeEach(() => observe.mockReset())

function fixture() {
  const session = { id: 'existing', close: vi.fn(async () => {}) } as unknown as HarnessSession
  const getSession = vi.fn((): HarnessSession | undefined => undefined)
  const resumeSession = vi.fn(async () => session)
  const createSession = vi.fn()
  const harness = { getSession, resumeSession, createSession } as unknown as Harness
  return { session, harness, getSession, resumeSession, createSession }
}

describe('host session restoration', () => {
  it('reuses loaded instances without preparing or applying new config', async () => {
    const f = fixture()
    f.getSession.mockReturnValue(f.session)
    const prepare = vi.fn()
    expect(await resumeRuntimeSession(f.harness, 'existing', prepare)).toBe(f.session)
    expect(prepare).not.toHaveBeenCalled()
    expect(f.resumeSession).not.toHaveBeenCalled()
  })

  it('joins UI and peer opens, including config preparation and observation', async () => {
    const f = fixture()
    const config = { appendSystemPrompt: 'host prompt', mcp: { servers: {} } }
    const prepare = vi.fn(async () => config)
    const other = vi.fn()
    const [a, b] = await Promise.all([
      resumeRuntimeSession(f.harness, 'existing', prepare),
      resumeRuntimeSession(f.harness, 'existing', other),
    ])
    expect(a).toBe(b)
    expect(prepare).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
    expect(f.resumeSession).toHaveBeenCalledOnce()
    expect(f.resumeSession).toHaveBeenCalledWith('existing', { config })
    expect(observe).toHaveBeenCalledOnce()
  })

  it('propagates missing-history errors and allows retry without creating a conversation', async () => {
    const f = fixture()
    f.resumeSession.mockRejectedValueOnce(new Error('history not found'))
    const prepare = async () => ({})
    await expect(resumeRuntimeSession(f.harness, 'existing', prepare)).rejects.toThrow('history not found')
    expect(f.createSession).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(await resumeRuntimeSession(f.harness, 'existing', prepare)).toBe(f.session)
  })

  it('does not open on defaults when host configuration fails', async () => {
    const f = fixture()
    await expect(resumeRuntimeSession(f.harness, 'existing', async () => { throw new Error('MCP unavailable') })).rejects.toThrow('MCP unavailable')
    expect(f.resumeSession).not.toHaveBeenCalled()
    expect(f.createSession).not.toHaveBeenCalled()
  })

  it('joins a load already in flight elsewhere instead of failing on its own options', async () => {
    const f = fixture()
    f.resumeSession.mockRejectedValueOnce(new SessionAlreadyLoadingError('existing'))
    expect(await resumeRuntimeSession(f.harness, 'existing', async () => ({}))).toBe(f.session)
    expect(f.resumeSession).toHaveBeenCalledTimes(2)
    expect(f.resumeSession).toHaveBeenLastCalledWith('existing')
  })

  it('closes a newly restored instance when observer wiring fails', async () => {
    const f = fixture()
    observe.mockImplementationOnce(() => { throw new Error('observer failed') })
    await expect(resumeRuntimeSession(f.harness, 'existing', async () => ({}))).rejects.toThrow('observer failed')
    expect(f.session.close).toHaveBeenCalledOnce()
    expect(await resumeRuntimeSession(f.harness, 'existing', async () => ({}))).toBe(f.session)
  })
})
