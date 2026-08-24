import { Hono } from 'hono'
import type { CanvasWorkflowStorageAdapter, ChatStorageAdapter, CronjobStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'
import type { CronjobUpsertInput } from '../types/cronjob.js'
import { createCronjob, deleteCronjob, executeCronjob, getCronjobExecutionHistory, listCronjobs, updateCronjob } from '../services/cronjob.js'

type CronjobStorage = CronjobStorageAdapter & ChatStorageAdapter & CanvasWorkflowStorageAdapter & ProjectStorageAdapter

export function cronjobRoutes(storage: CronjobStorage) {
  const router = new Hono()

  router.get('/', (c) => {
    const cronjobs = listCronjobs(storage)
    return c.json({ cronjobs })
  })

  router.post('/', async (c) => {
    const payload = await c.req.json<CronjobUpsertInput>()
    try {
      const cronjob = createCronjob(storage, payload)
      return c.json({ cronjob })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid cronjob input'
      return c.json({ error: message }, 400)
    }
  })

  router.put('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const payload = await c.req.json<CronjobUpsertInput>()
    try {
      const cronjob = updateCronjob(storage, id, payload)
      if (!cronjob) return c.json({ error: 'Cronjob not found' }, 404)
      return c.json({ cronjob })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid cronjob input'
      return c.json({ error: message }, 400)
    }
  })

  router.delete('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const success = deleteCronjob(storage, id)
    if (!success) return c.json({ error: 'Cronjob not found' }, 404)
    return c.json({ success: true })
  })

  router.get('/:id/history', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const history = getCronjobExecutionHistory(storage, id)
    return c.json({ history })
  })

  router.post('/:id/run', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const result = await executeCronjob(storage, id)
    if (!result.success) {
      return c.json({ success: false, error: result.error, cronjob: result.cronjob }, 500)
    }
    return c.json({ success: true, cronjob: result.cronjob })
  })

  return router
}
