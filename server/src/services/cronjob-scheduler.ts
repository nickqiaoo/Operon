import type { CanvasWorkflowStorageAdapter, ChatStorageAdapter, CronjobStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'
import { computeNextRunAtForJob, executeCronjob, listCronjobs, setCronjobNextRunAt } from './cronjob.js'

export interface CronjobSchedulerOptions {
  intervalMs?: number
}

const TAG = '[CronjobScheduler]'
const STALE_THRESHOLD_MS = 60 * 60_000 // 1 hour

export function startCronjobScheduler(
  storage: CronjobStorageAdapter & ChatStorageAdapter & CanvasWorkflowStorageAdapter & ProjectStorageAdapter,
  options: CronjobSchedulerOptions = {}
): () => void {
  const intervalMs = options.intervalMs ?? 10_000
  const running = new Set<number>()

  const tick = async () => {
    const now = Date.now()
    const cronjobs = listCronjobs(storage)

    for (const job of cronjobs) {
      if (!job.enabled) continue
      const nextRunAt = job.nextRunAt ?? computeNextRunAtForJob(job, now)
      if (!nextRunAt) continue

      if (nextRunAt <= now) {
        // Skip if overdue by more than 1 hour
        if (now - nextRunAt > STALE_THRESHOLD_MS) {
          const nextNext = computeNextRunAtForJob({ ...job, lastRunAt: now }, now)
          setCronjobNextRunAt(storage, job.id, nextNext)
          console.log(`${TAG} Skipping "${job.name}" (${job.id}) - overdue by ${Math.round((now - nextRunAt) / 60_000)}min, next run at ${nextNext ? new Date(nextNext).toISOString() : 'N/A'}`)
          continue
        }

        if (running.has(job.id)) {
          console.log(`${TAG} Skipping "${job.name}" (${job.id}) - already running`)
          continue
        }

        // Immediately compute and persist the next run time before execution
        const nextNext = computeNextRunAtForJob({ ...job, lastRunAt: now }, now)
        setCronjobNextRunAt(storage, job.id, nextNext)
        console.log(`${TAG} Starting "${job.name}" (${job.id}), next run at ${nextNext ? new Date(nextNext).toISOString() : 'N/A'}`)

        running.add(job.id)

        // Fire and forget - don't wait for execution
        executeCronjob(storage, job.id)
          .then(() => {
            console.log(`${TAG} Completed "${job.name}" (${job.id})`)
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : 'Unknown error'
            console.error(`${TAG} Failed "${job.name}" (${job.id}): ${msg}`)
          })
          .finally(() => running.delete(job.id))

        continue
      }

      if (job.nextRunAt !== nextRunAt) {
        setCronjobNextRunAt(storage, job.id, nextRunAt)
        console.log(`${TAG} Set nextRunAt for "${job.name}" (${job.id}) to ${new Date(nextRunAt).toISOString()}`)
      }
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)

  console.log(`${TAG} Started with interval ${intervalMs}ms`)
  void tick()

  return () => clearInterval(timer)
}
