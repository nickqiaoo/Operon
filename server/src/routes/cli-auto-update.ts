import { Hono } from 'hono'
import { isCliAutoUpdateAdapterId } from '../../../shared/cli-auto-update.js'
import {
  getCliAutoUpdateState,
  getCliAutoUpdateStatus,
  runCliUpdate,
  setCliAutoUpdateEnabled,
} from '../services/cli-auto-update.js'

export function cliAutoUpdateRoutes() {
  const router = new Hono()

  router.get('/', (c) => c.json(getCliAutoUpdateState()))

  router.put('/:adapterId', async (c) => {
    const adapterId = c.req.param('adapterId')
    if (!isCliAutoUpdateAdapterId(adapterId)) return c.json({ error: 'Invalid adapter id' }, 400)
    const body = await c.req.json<{ enabled?: unknown }>()
    if (typeof body.enabled !== 'boolean') return c.json({ error: '`enabled` must be a boolean' }, 400)
    return c.json(setCliAutoUpdateEnabled(adapterId, body.enabled))
  })

  // Starts the update and returns at once — a package-manager update can run
  // for minutes. The UI polls GET '/' while `running` is true.
  router.post('/:adapterId/run', (c) => {
    const adapterId = c.req.param('adapterId')
    if (!isCliAutoUpdateAdapterId(adapterId)) return c.json({ error: 'Invalid adapter id' }, 400)
    void runCliUpdate(adapterId, 'manual')
    return c.json(getCliAutoUpdateStatus(adapterId))
  })

  return router
}
