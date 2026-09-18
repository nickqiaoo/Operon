/**
 * Shared coloring for the Claude / Codex rate-limit popovers and their composer
 * trigger, so the bar and the percentage never disagree about how close a
 * window is to its limit.
 */
export type UsageLevel = 'ok' | 'warn' | 'critical'

export const usageLevel = (used: number): UsageLevel => {
  if (used >= 85) return 'critical'
  if (used >= 60) return 'warn'
  return 'ok'
}

/**
 * Bar fill: green while there is headroom, warm orange past the halfway-ish
 * mark, and `accent-red` when the window is nearly spent.
 *
 * All three come from the one accent ramp. `critical` used to be
 * `bg-destructive`, which is mixed to fill a button and carry white text — as a
 * 4-6px bar it stopped reading as a meter and started reading as a fault light,
 * and next to accent-warm / accent-green it was plainly from a different set.
 * The `status-*` label tokens are the other wrong answer here: those are tuned
 * for text contrast, so as a fill they come out pale (#fca5a5 in dark).
 */
export const usageBarTone = (used: number): string => {
  switch (usageLevel(used)) {
    case 'critical':
      return 'bg-accent-red'
    case 'warn':
      return 'bg-accent-warm'
    default:
      return 'bg-accent-green'
  }
}

/**
 * Text for a percentage label. Stays quiet (`fallback`) until the window is
 * nearly spent, so the composer trigger doesn't turn orange at 60%.
 */
export const usageTextTone = (used: number, fallback = 'text-muted-foreground'): string =>
  usageLevel(used) === 'critical' ? 'text-status-error' : fallback

/**
 * The same levels for the packaged apps' native info sheet. `tone` colors the
 * percentage (quiet until critical, like the web label); `barTone` colors the
 * bar through all three levels. App builds that predate `barTone` ignore it and
 * fall back to coloring the bar from `tone`.
 */
export const nativeUsageTones = (
  used: number,
): { tone: 'normal' | 'error'; barTone: 'ok' | 'warn' | 'error' } => {
  const level = usageLevel(used)
  return {
    tone: level === 'critical' ? 'error' : 'normal',
    barTone: level === 'critical' ? 'error' : level,
  }
}
