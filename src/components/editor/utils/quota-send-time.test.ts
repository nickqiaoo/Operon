import { expect, it } from 'vitest'
import { canScheduleAt, MAX_SEND_DELAY_MINUTES } from '@shared/scheduled-messages'
import { quotaSendTime } from './quota-send-time'

it('accepts exactly 12 hours and includes the quota buffer in the limit', () => {
  const now = Date.now()
  const limit = now + MAX_SEND_DELAY_MINUTES * 60_000
  const reset = (at: number) => quotaSendTime('opus', null, { windows: {
    five_hour: { status: 'rejected', resetsAt: now + 60_000 },
    seven_day_opus: { status: 'rejected', resetsAt: at },
    seven_day_sonnet: { status: 'rejected', resetsAt: limit + 86_400_000 },
  } }, now)
  expect(reset(limit - 30_000)).toBe(limit)
  expect(canScheduleAt(reset(limit - 30_000), now)).toBe(true)
  expect(canScheduleAt(reset(limit - 29_999), now)).toBe(false)
  expect(canScheduleAt(now, now)).toBe(false)
})
