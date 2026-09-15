import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../gateway/saas/config.js', () => ({
  getSaasConfig: () => ({ nodeToken: 'node-token' }),
}))

import { relayPush, type PushMessage } from './push-relay.js'
import { isUserAtDesktop, setDesktopPresenceProbe } from './desktop-presence.js'

let sourceSeq = 0
function message(): PushMessage {
  sourceSeq += 1
  return { severity: 'action', sourceKey: `chat:${sourceSeq}`, title: 'Chat', body: 'Waiting for approval' }
}

describe('relayPush desktop presence', () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  let present = false

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockClear()
    present = false
    setDesktopPresenceProbe(() => present)
  })

  afterEach(() => {
    setDesktopPresenceProbe(null)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('pushes immediately when nobody is at the desktop', () => {
    relayPush(message())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('pushes immediately on a headless node with no presence probe', () => {
    present = true
    setDesktopPresenceProbe(null)
    relayPush(message())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('holds the push while the user is at the desktop and sends once they step away', () => {
    present = true
    relayPush(message(), () => true)
    vi.advanceTimersByTime(90_000)
    expect(fetchMock).not.toHaveBeenCalled()

    present = false
    vi.advanceTimersByTime(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('drops the held push once the event is handled on the desktop', () => {
    present = true
    let pending = true
    relayPush(message(), () => pending)
    pending = false
    present = false
    vi.advanceTimersByTime(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gives up on a push held longer than the APNs expiration', () => {
    present = true
    relayPush(message(), () => true)
    vi.advanceTimersByTime(61 * 60_000)
    present = false
    vi.advanceTimersByTime(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps only one held push per source', () => {
    present = true
    const msg = message()
    relayPush(msg, () => true)
    relayPush(msg, () => true)
    present = false
    vi.advanceTimersByTime(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('isUserAtDesktop', () => {
  it('counts the user as present while they use another app', () => {
    // No focus input at all: switching to a terminal is not leaving the computer.
    expect(isUserAtDesktop({ windowOpen: true, idleState: 'active' })).toBe(true)
  })

  it('counts idle, locked, unknown, or a closed window as away', () => {
    expect(isUserAtDesktop({ windowOpen: true, idleState: 'idle' })).toBe(false)
    expect(isUserAtDesktop({ windowOpen: true, idleState: 'locked' })).toBe(false)
    expect(isUserAtDesktop({ windowOpen: true, idleState: 'unknown' })).toBe(false)
    expect(isUserAtDesktop({ windowOpen: false, idleState: 'active' })).toBe(false)
  })
})
