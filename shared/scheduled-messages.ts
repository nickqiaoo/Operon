export const MAX_SEND_DELAY_MINUTES = 12 * 60

export function canScheduleAt(at: number | null, now = Date.now()): at is number {
  return at !== null && Number.isSafeInteger(at) && at > now && at - now <= MAX_SEND_DELAY_MINUTES * 60_000
}
