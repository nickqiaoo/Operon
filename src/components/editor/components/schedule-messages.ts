import { defineMessages, type IntlShape } from 'react-intl'

export const scheduleText = defineMessages({
  title: { id: 'editor.schedule.title', defaultMessage: 'Schedule message' },
  limit: { id: 'editor.schedule.limit', defaultMessage: 'Within 12 hours' },
  quota: { id: 'editor.schedule.quota', defaultMessage: 'After quota reset' },
  tooLate: { id: 'editor.schedule.tooLate', defaultMessage: 'Reset is beyond 12 hours' },
  unknown: { id: 'editor.schedule.unknown', defaultMessage: 'Reset time unavailable' },
  mode: { id: 'editor.schedule.mode', defaultMessage: 'Schedule by' },
  delay: { id: 'editor.schedule.delay', defaultMessage: 'Delay' },
  date: { id: 'editor.schedule.date', defaultMessage: 'Date & time' },
  minutes: { id: 'editor.schedule.minutes', defaultMessage: 'minutes' },
  minutesLabel: { id: 'editor.schedule.minutesLabel', defaultMessage: 'Delay in minutes' },
  preset: { id: 'editor.schedule.preset', defaultMessage: '{count} min' },
  oneHour: { id: 'editor.schedule.oneHour', defaultMessage: '1 hour' },
  inMinutes: { id: 'editor.schedule.inMinutes', defaultMessage: 'In {count} min' },
  apply: { id: 'editor.schedule.apply', defaultMessage: 'Use this time' },
  clear: { id: 'editor.schedule.clear', defaultMessage: 'Clear scheduled time' },
  today: { id: 'editor.schedule.today', defaultMessage: 'Today' },
  tomorrow: { id: 'editor.schedule.tomorrow', defaultMessage: 'Tomorrow' },
  hour: { id: 'editor.schedule.hour', defaultMessage: 'Hour' },
  minute: { id: 'editor.schedule.minute', defaultMessage: 'Minute' },
  failed: { id: 'editor.schedule.failed', defaultMessage: 'Could not send' },
  sending: { id: 'editor.schedule.sending', defaultMessage: 'Sending…' },
  waiting: { id: 'editor.schedule.waiting', defaultMessage: 'Waiting for current turn' },
  dismiss: { id: 'editor.schedule.dismiss', defaultMessage: 'Dismiss' },
  cancel: { id: 'editor.schedule.cancel', defaultMessage: 'Cancel' },
  cancelError: { id: 'editor.schedule.cancelError', defaultMessage: 'Could not cancel message' },
  enqueueError: { id: 'editor.schedule.enqueueError', defaultMessage: 'Could not schedule message' },
  goal: { id: 'editor.schedule.goal', defaultMessage: 'Turn off Goal mode to schedule a message.' },
  range: { id: 'editor.schedule.range', defaultMessage: 'Choose a time within the next 12 hours.' },
  invalid: { id: 'editor.schedule.invalid', defaultMessage: 'Choose a future time and enter a message.' },
  gone: { id: 'editor.schedule.gone', defaultMessage: 'This message is no longer pending.' },
})

export function displaySendTime(intl: IntlShape, at: number) {
  return intl.formatDate(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
}
