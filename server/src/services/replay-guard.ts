import { E2EE_FRESHNESS_MS } from '@shared/e2ee/protocol'

export type ReplayVerdict = 'fresh' | 'stale' | 'replayed'

/**
 * Refuses an encrypted request (or WebSocket connection) Broker recorded and
 * sends again. Sealing does not stop that on its own: the same ciphertext opens
 * with the same key every time.
 *
 * A timed request is accepted within `windowMs` of this machine's clock, once:
 * its nonce is remembered until its time leaves the window, after which the
 * time check refuses it anyway. An untimed (v1) request can only be checked
 * against the nonces of the last two windows.
 *
 * Only call it after the envelope opened, so nothing unauthenticated fills it.
 * Memory only: a restart forgets the nonces, which leaves a replay window of
 * `windowMs` for timed requests right after a restart.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>()
  private nextSweep = 0

  constructor(
    private readonly windowMs = E2EE_FRESHNESS_MS,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string, time?: number): ReplayVerdict {
    const now = this.now()
    if (time !== undefined && (!Number.isSafeInteger(time) || Math.abs(now - time) > this.windowMs)) return 'stale'
    this.sweep(now)
    const expires = this.seen.get(key)
    if (expires !== undefined && expires > now) return 'replayed'
    this.seen.set(key, (time ?? now) + this.windowMs * (time === undefined ? 2 : 1))
    return 'fresh'
  }

  get size(): number {
    return this.seen.size
  }

  private sweep(now: number): void {
    if (now < this.nextSweep) return
    this.nextSweep = now + 30_000
    for (const [key, expires] of this.seen) if (expires <= now) this.seen.delete(key)
  }
}

/** Shared by the HTTP middleware and the terminal WebSocket. */
export const remoteReplayGuard = new ReplayGuard()

/** A request's time header, or undefined when absent; NaN when present but not a number. */
export function parseE2EETime(value: string | undefined | null): number | undefined {
  if (value == null || value === '') return undefined
  return /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN
}
