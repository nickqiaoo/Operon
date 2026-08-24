import { Hono } from 'hono'
import type { MemoryMaintenanceStorageAdapter } from '../storage/interface.js'
import type { MemoryMaintenanceConfig } from '../types/memory-maintenance.js'
import { runMemoryMaintenance } from '../services/memory-maintenance/runner.js'
import { readRunLog } from '../services/memory-maintenance/run-log.js'

interface UpdateBody {
  enabled?: boolean
  scheduleTime?: string
  providerId?: string | null
  modelId?: string | null
  layer1Enabled?: boolean
  maxSessionsPerRun?: number
}

function validateScheduleTime(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim())
}

export function memoryMaintenanceRoutes(storage: MemoryMaintenanceStorageAdapter) {
  const router = new Hono()
  let activeRun: { promise: Promise<unknown>; abort: AbortController } | null = null

  router.get('/config', (c) => {
    const config = storage.getMemoryMaintenanceConfig()
    return c.json(config)
  })

  router.patch('/config', async (c) => {
    const body = await c.req.json<UpdateBody>().catch(() => ({} as UpdateBody))
    const updates: Partial<Omit<MemoryMaintenanceConfig, 'updatedAt'>> = {}

    if (body.enabled !== undefined) updates.enabled = !!body.enabled
    if (body.scheduleTime !== undefined) {
      if (!validateScheduleTime(body.scheduleTime)) {
        return c.json({ error: 'scheduleTime must be HH:MM (24h)' }, 400)
      }
      updates.scheduleTime = body.scheduleTime.trim()
    }
    if (body.providerId !== undefined) updates.providerId = body.providerId ?? undefined
    if (body.modelId !== undefined) updates.modelId = body.modelId ?? undefined
    if (body.layer1Enabled !== undefined) updates.layer1Enabled = !!body.layer1Enabled
    if (body.maxSessionsPerRun !== undefined) {
      const n = Number(body.maxSessionsPerRun)
      if (!Number.isFinite(n) || n <= 0 || n > 500) {
        return c.json({ error: 'maxSessionsPerRun must be between 1 and 500' }, 400)
      }
      updates.maxSessionsPerRun = Math.floor(n)
    }

    const next = storage.updateMemoryMaintenanceConfig(updates)
    return c.json(next)
  })

  router.get('/runs', (c) => {
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Math.min(100, Math.max(1, Number(limitRaw))) : 20
    const runs = storage.listMemoryMaintenanceRuns(limit)
    return c.json(runs)
  })

  router.get('/runs/:id/log', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'invalid run id' }, 400)
    }
    const content = readRunLog(id)
    if (content === null) {
      return c.json({ error: 'log not found', content: '' }, 404)
    }
    return c.json({ content })
  })

  router.post('/run', async (c) => {
    if (activeRun) {
      return c.json({ error: 'A maintenance run is already in progress' }, 409)
    }
    const abort = new AbortController()
    const promise = runMemoryMaintenance(storage, {
      trigger: 'manual',
      signal: abort.signal,
    })
      .catch((err) => ({ status: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        if (activeRun && activeRun.abort === abort) activeRun = null
      })
    activeRun = { promise, abort }
    const outcome = await promise
    return c.json(outcome)
  })

  router.post('/abort', (c) => {
    if (!activeRun) return c.json({ error: 'No active run' }, 404)
    activeRun.abort.abort()
    return c.json({ success: true })
  })

  return router
}
