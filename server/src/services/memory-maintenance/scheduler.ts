import type { MemoryMaintenanceStorageAdapter } from '../../storage/interface.js'
import { createRuntimeLogger } from '@operon/agent-runtime'
import { runMemoryMaintenance } from './runner.js'

const logger = createRuntimeLogger('memory-maintenance-scheduler')

const TICK_INTERVAL_MS = 60_000
const STALE_THRESHOLD_MS = 30 * 60_000

export interface SchedulerOptions {
  intervalMs?: number
}

function parseHHMM(value: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return { h, m }
}

function nextFireAt(now: Date, h: number, m: number): number {
  const target = new Date(now)
  target.setSeconds(0, 0)
  target.setHours(h, m, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  return target.getTime()
}

/**
 * Starts a lightweight scheduler that fires `runMemoryMaintenance` once
 * per day at the configured local time. One-ticker-per-minute polling
 * keeps the logic trivial; we track `lastFiredDay` in memory to prevent
 * double-firing within the same day, and reload the config on each tick
 * so settings changes take effect immediately.
 */
export function startMemoryMaintenanceScheduler(
  storage: MemoryMaintenanceStorageAdapter,
  options: SchedulerOptions = {}
): () => void {
  const intervalMs = options.intervalMs ?? TICK_INTERVAL_MS
  let running = false
  let lastFiredDay = ''

  const tick = async () => {
    if (running) return
    let config
    try {
      config = storage.getMemoryMaintenanceConfig()
    } catch (err) {
      logger.warn(`config load failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!config.enabled) return
    if (!config.providerId) return

    const parsed = parseHHMM(config.scheduleTime)
    if (!parsed) {
      logger.warn(`invalid scheduleTime=${config.scheduleTime}`)
      return
    }

    const now = new Date()
    const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    const todayTargetMs = new Date(now).setHours(parsed.h, parsed.m, 0, 0)

    if (now.getTime() < todayTargetMs) return
    if (lastFiredDay === todayKey) return

    // Staleness guard: if today's target window was missed by more than the
    // threshold (e.g. the server was off at 04:00 and came back at 18:00),
    // skip today and wait for tomorrow. Mimics cronjob-scheduler's behavior.
    const overdueMs = now.getTime() - todayTargetMs
    if (overdueMs > STALE_THRESHOLD_MS) {
      lastFiredDay = todayKey
      const nextTarget = nextFireAt(now, parsed.h, parsed.m)
      logger.info(
        `skipping today's run — ${Math.round(overdueMs / 60_000)}min past target ${config.scheduleTime}; next at ${new Date(nextTarget).toISOString()}`
      )
      return
    }

    lastFiredDay = todayKey
    running = true
    const nextTarget = nextFireAt(now, parsed.h, parsed.m)
    logger.info(
      `firing scheduled run at ${now.toISOString()} (target ${config.scheduleTime}; next at ${new Date(nextTarget).toISOString()})`
    )

    try {
      const outcome = await runMemoryMaintenance(storage, { trigger: 'scheduled' })
      logger.info(`daily run ${outcome.runId} finished status=${outcome.status}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`daily run failed: ${msg}`)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)

  logger.info(`started (tick ${intervalMs}ms)`)
  return () => clearInterval(timer)
}
