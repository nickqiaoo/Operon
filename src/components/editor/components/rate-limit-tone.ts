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
 * Bar fill. These are the fill tokens (tuned to be painted as a solid block),
 * not the `status-*` label tokens: green while there is headroom, warm orange
 * past the halfway-ish mark, red when the window is nearly spent.
 */
export const usageBarTone = (used: number): string => {
  switch (usageLevel(used)) {
    case 'critical':
      return 'bg-destructive'
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
