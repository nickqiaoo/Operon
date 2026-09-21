/**
 * Shared coloring for quota bars and composer badges. Detail labels stay
 * neutral; the bar already indicates how close the window is to its limit.
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
 * Text for a composer badge. Stays quiet (`fallback`) until the window is
 * nearly spent. Mix in a little neutral text color to soften red on thin
 * digits and icons; solid progress bars keep the full accent color.
 */
export const usageTextTone = (used: number, fallback = 'text-muted-foreground'): string =>
  usageLevel(used) === 'critical'
    ? 'text-[color:color-mix(in_srgb,var(--color-accent-red)_80%,var(--color-muted-foreground))]'
    : fallback

/**
 * Native detail labels stay neutral, like the web popover; only the bar
 * changes color with the usage level.
 */
export const nativeUsageTones = (
  used: number,
): { tone: 'normal'; barTone: 'ok' | 'warn' | 'error' } => {
  const level = usageLevel(used)
  return {
    tone: 'normal',
    barTone: level === 'critical' ? 'error' : level,
  }
}
