import type { IntlShape } from "react-intl"

/**
 * Shared display formatters. Anything shown to the user as time, duration or
 * size goes through here, so the same quantity reads the same everywhere and
 * follows the UI language (react-intl's locale), not a hard-coded English string.
 */

type TimeInput = number | string | Date

function toMs(time: TimeInput): number {
  return time instanceof Date ? time.getTime() : typeof time === "string" ? new Date(time).getTime() : time
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago `time` was: "now" / "5m ago" / "3h ago" / "yesterday" / "4d ago" /
 * "2mo ago" (English), "5分钟前" / "昨天" … (Chinese).
 *
 * - `compact`: no "ago" — "5m" / "3h" / "4d" — for dense rows (task lists,
 *   activity feeds). Past 30 days it shows the date instead ("Sep 3").
 * - `dateAfterDays`: show the date (with time) instead once it is this many days
 *   old, for places where "3d ago" is too vague to act on (run history).
 *
 * An unparseable input yields "".
 */
export function formatRelativeTime(
  intl: IntlShape,
  time: TimeInput,
  { compact = false, dateAfterDays }: { compact?: boolean; dateAfterDays?: number } = {},
): string {
  const ms = toMs(time)
  if (Number.isNaN(ms)) return ""
  const diff = Math.max(0, Date.now() - ms)

  if (dateAfterDays != null && diff >= dateAfterDays * DAY) {
    return intl.formatDate(ms, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  }

  if (compact) {
    if (diff < MINUTE) return intl.formatRelativeTime(0, "second", { numeric: "auto" })
    if (diff >= 30 * DAY) return intl.formatDate(ms, { month: "short", day: "numeric" })
    const [value, unit] =
      diff < HOUR ? [Math.floor(diff / MINUTE), "minute"] as const
      : diff < DAY ? [Math.floor(diff / HOUR), "hour"] as const
      : [Math.floor(diff / DAY), "day"] as const
    return intl.formatNumber(value, { style: "unit", unit, unitDisplay: "narrow" })
  }

  const rel = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    intl.formatRelativeTime(-value, unit, { numeric: "auto", style: "narrow" })
  if (diff < MINUTE) return rel(0, "second")
  if (diff < HOUR) return rel(Math.floor(diff / MINUTE), "minute")
  if (diff < DAY) return rel(Math.floor(diff / HOUR), "hour")
  if (diff < 30 * DAY) return rel(Math.floor(diff / DAY), "day")
  if (diff < 365 * DAY) return rel(Math.floor(diff / (30 * DAY)), "month")
  return rel(Math.floor(diff / (365 * DAY)), "year")
}

/** Elapsed time: "850ms" / "4.2s" / "42s" / "3m 05s" / "2h 05m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const totalSeconds = Math.floor(s)
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** A byte count in binary units: "512 B" / "4.0 KB" / "12.3 MB" / "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  if (exp === 0) return `${bytes} B`
  return `${(bytes / 1024 ** exp).toFixed(1)} ${units[exp]}`
}
