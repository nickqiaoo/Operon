import type { AssistantSchedule, AssistantScheduleRun } from '../../../../shared/assistant.js'
import type { AssistantStorageAdapter, CronjobStorageAdapter, StorageAdapter } from '../../storage/interface.js'
import type { CronjobSchedule, CronjobTask } from '../../types/cronjob.js'
import { computeNextRunAtForJob, normalizeSchedule } from '../cronjob.js'
import { DEFAULT_PROFILE_FILES } from './defaults.js'

type Storage = StorageAdapter & AssistantStorageAdapter & CronjobStorageAdapter

const HEARTBEAT_KEY = 'assistant:heartbeat_job'
/** How often the heartbeat looks around. */
export const HEARTBEAT_MINUTES = 30
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const RUNS_SHOWN = 10
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const HEARTBEAT_SCHEDULE: CronjobSchedule = { type: 'daily', time: '00:00', days: EVERY_DAY, intervalMinutes: HEARTBEAT_MINUTES, endTime: '23:59' }

/** What the main agent passes to set up or change a scheduled task. */
export interface ScheduleInput {
  name: string
  prompt: string
  /** `HH:MM`: when it runs, or where an every-N-minutes window starts. */
  time: string
  /** 0 = Sunday. Every day when left out. */
  days?: number[]
  everyMinutes?: number
  /** `HH:MM`: where an every-N-minutes window ends. */
  until?: string
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i])
}

function daysLabel(days: readonly number[]): string {
  const sorted = [...days].sort()
  if (sameDays(sorted, EVERY_DAY)) return ''
  if (sameDays(sorted, [1, 2, 3, 4, 5])) return 'weekdays'
  if (sameDays(sorted, [0, 6])) return 'weekends'
  return sorted.map((d) => DAY_NAMES[d]).join(', ')
}

/** "Every 30 minutes", "Weekdays at 08:40", "Every 2 hours, 09:00–18:00 on weekends". */
export function cadenceOf(schedule: CronjobSchedule): string {
  const days = daysLabel(schedule.days)
  if (schedule.intervalMinutes) {
    const n = schedule.intervalMinutes
    const every = n % 60 === 0 ? (n === 60 ? 'Every hour' : `Every ${n / 60} hours`) : `Every ${n} minutes`
    const allDay = schedule.time === '00:00' && (schedule.endTime ?? '23:59') === '23:59'
    const window = allDay ? '' : `, ${schedule.time}–${schedule.endTime}`
    return `${every}${window}${days ? ` on ${days}` : ''}`
  }
  if (!days) return `Daily at ${schedule.time}`
  if (days === 'weekdays' || days === 'weekends') return `${days[0]!.toUpperCase()}${days.slice(1)} at ${schedule.time}`
  return `${days} at ${schedule.time}`
}

function minutesOf(hhmm: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined
}

/** Whether `now` falls in the quiet window; a window may run past midnight (23:00–08:00). */
export function inQuietHours(now: Date, start: string, end: string): boolean {
  const s = minutesOf(start)
  const e = minutesOf(end)
  if (s === undefined || e === undefined || s === e) return false
  const t = now.getHours() * 60 + now.getMinutes()
  return s < e ? t >= s && t < e : t >= s || t < e
}

/** List items of a markdown file, minus the ones that came with the default template. */
function ownItems(content: string, template: string): string[] {
  const defaults = new Set(template.split('\n').map((l) => l.trim()))
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l) && !defaults.has(l))
}

/** The bullet lines under memory.md's "In progress" heading. */
function inProgress(memory: string): string[] {
  const items: string[] = []
  let inside = false
  for (const line of memory.split('\n')) {
    if (/^#+\s/.test(line)) inside = /^#+\s*in progress\s*$/i.test(line.trim())
    else if (inside && /^\s*[-*]\s+\S/.test(line)) items.push(line.trim())
  }
  return items
}

/**
 * Whether a heartbeat has anything to look at: a connected service, something the user asked
 * it to watch, or something in progress to follow up on. Nothing at all → skip the model call.
 */
export function heartbeatHasWork(heartbeat: string, memory: string, connectors: readonly string[]): boolean {
  return connectors.length > 0 || ownItems(heartbeat, DEFAULT_PROFILE_FILES.heartbeat).length > 0 || inProgress(memory).length > 0
}

/** heartbeat.md without the given lines (entries whose `until` date has passed). */
export function removeLines(content: string, lines: readonly string[]): string {
  const drop = new Set(lines.map((l) => l.trim()).filter(Boolean))
  if (!drop.size) return content
  return content
    .split('\n')
    .filter((l) => !drop.has(l.trim()))
    .join('\n')
}

/**
 * The assistant's heartbeat and scheduled tasks. They are rows in the app's cronjob table
 * (`task_type = 'assistant'`), so the app's scheduler times them; the generic Schedule page and
 * the coding chats' schedule tools leave them alone (services/cronjob.ts), and this is where
 * they are made and changed.
 */
export class AssistantSchedules {
  constructor(
    private readonly storage: Storage,
    private readonly changed: (schedules: AssistantSchedule[]) => void,
  ) {}

  /** The heartbeat's job, created on first use and always kept on. */
  ensureHeartbeat(): CronjobTask {
    const id = this.storage.get<number>(HEARTBEAT_KEY)
    const existing = id !== undefined ? this.storage.getCronjobById(id) : undefined
    if (existing && existing.taskType === 'assistant') {
      if (existing.enabled) return existing
      const enabled = { ...existing, enabled: true, updatedAt: Date.now() }
      enabled.nextRunAt = computeNextRunAtForJob(enabled, Date.now())
      this.storage.upsertCronjob(enabled)
      return enabled
    }
    const now = Date.now()
    const job: CronjobTask = {
      id: 0,
      name: 'Heartbeat',
      enabled: true,
      taskType: 'assistant',
      providerId: '',
      prompt: '',
      schedule: HEARTBEAT_SCHEDULE,
      createdAt: now,
      updatedAt: now,
    }
    job.nextRunAt = computeNextRunAtForJob(job, now)
    this.storage.upsertCronjob(job)
    this.storage.set(HEARTBEAT_KEY, job.id)
    return job
  }

  isHeartbeat(id: number): boolean {
    return this.storage.get<number>(HEARTBEAT_KEY) === id
  }

  /** The assistant's own job with this id. */
  job(id: number): CronjobTask | undefined {
    const job = this.storage.getCronjobById(id)
    return job?.taskType === 'assistant' ? job : undefined
  }

  /** Heartbeat first, then by next run. */
  list(): AssistantSchedule[] {
    return this.storage
      .listCronjobs()
      .filter((job) => job.taskType === 'assistant')
      .map((job) => this.view(job))
      .sort((a, b) => (a.builtin ? -1 : b.builtin ? 1 : (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)))
  }

  create(input: ScheduleInput): AssistantSchedule {
    const now = Date.now()
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (!name) throw new Error('name is required')
    if (!prompt) throw new Error('prompt is required')
    const job: CronjobTask = {
      id: 0,
      name,
      enabled: true,
      taskType: 'assistant',
      providerId: '',
      prompt,
      schedule: this.schedule(input),
      createdAt: now,
      updatedAt: now,
    }
    job.nextRunAt = computeNextRunAtForJob(job, now)
    this.storage.upsertCronjob(job)
    this.publish()
    return this.view(job)
  }

  update(id: number, patch: Partial<ScheduleInput> & { enabled?: boolean }): AssistantSchedule {
    const current = this.job(id)
    if (!current) throw new Error(`There is no scheduled task ${id}.`)
    if (this.isHeartbeat(id)) throw new Error('The heartbeat cannot be changed or paused. Edit heartbeat.md to change what it watches.')
    const now = Date.now()
    const timing = patch.time !== undefined || patch.days !== undefined || patch.everyMinutes !== undefined || patch.until !== undefined
    const s = current.schedule
    const next: CronjobTask = {
      ...current,
      name: patch.name?.trim() || current.name,
      prompt: patch.prompt?.trim() || current.prompt,
      enabled: patch.enabled ?? current.enabled,
      schedule: timing
        ? this.schedule({
            time: patch.time ?? s.time,
            days: patch.days ?? s.days,
            everyMinutes: patch.everyMinutes ?? s.intervalMinutes,
            until: patch.until ?? s.endTime,
          })
        : s,
      updatedAt: now,
    }
    next.nextRunAt = computeNextRunAtForJob(next, now)
    this.storage.upsertCronjob(next)
    this.publish()
    return this.view(next)
  }

  remove(id: number): boolean {
    if (!this.job(id)) return false
    if (this.isHeartbeat(id)) throw new Error('The heartbeat cannot be deleted. Edit heartbeat.md to change what it watches.')
    this.storage.deleteCronjobById(id)
    this.storage.assistantRunDeleteFor(id)
    this.publish()
    return true
  }

  recordRun(run: AssistantScheduleRun): void {
    this.storage.assistantRunInsert(run)
    this.publish()
  }

  /** Tell the UI (the next run time moves after every run, too). */
  publish(): void {
    this.changed(this.list())
  }

  private schedule(input: Pick<ScheduleInput, 'time' | 'days' | 'everyMinutes' | 'until'>): CronjobSchedule {
    const days = input.days?.length ? input.days : EVERY_DAY
    return normalizeSchedule({
      type: 'daily',
      time: input.time,
      days,
      ...(input.everyMinutes ? { intervalMinutes: input.everyMinutes, endTime: input.until ?? '23:59' } : {}),
    })
  }

  private view(job: CronjobTask): AssistantSchedule {
    const s = job.schedule
    return {
      id: job.id,
      name: job.name,
      prompt: job.prompt,
      cadence: cadenceOf(s),
      time: s.time,
      days: s.days,
      ...(s.intervalMinutes ? { everyMinutes: s.intervalMinutes, until: s.endTime } : {}),
      ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
      enabled: job.enabled,
      ...(this.isHeartbeat(job.id) ? { builtin: 'heartbeat' as const } : {}),
      runs: this.storage.assistantRunList(job.id, RUNS_SHOWN),
    }
  }
}
