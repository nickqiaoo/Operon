import { Hono } from 'hono'
import { getCliPathInfo, isAdapterAvailable, probeCliVersion } from '../services/adapter/bundled-cli-paths.js'
import { CLI_ADAPTER_IDS, isCliAdapterId, setCliPathConfig } from '../services/cli-path-config.js'

export function cliPathConfigRoutes() {
  const router = new Hono()

  router.get('/', (c) => {
    const result: Record<string, ReturnType<typeof getCliPathInfo>> = {}
    for (const id of CLI_ADAPTER_IDS) {
      result[id] = getCliPathInfo(id)
    }
    return c.json(result)
  })

  // Deliberately NOT folded into GET '/': probing spawns the CLI, and doing that
  // for every adapter would put up to a spawn-per-CLI in front of the Settings
  // page opening. The UI asks for one adapter at a time, when its tab is shown.
  router.get('/:adapterId/version', async (c) => {
    const adapterId = c.req.param('adapterId')
    if (!isCliAdapterId(adapterId)) {
      return c.json({ error: 'Invalid adapter id' }, 400)
    }
    return c.json(await probeCliVersion(adapterId))
  })

  router.put('/:adapterId', async (c) => {
    const adapterId = c.req.param('adapterId')
    if (!isCliAdapterId(adapterId)) {
      return c.json({ success: false, error: 'Invalid adapter id' }, 400)
    }

    const body = await c.req.json<{ path?: string }>()
    setCliPathConfig(adapterId, body.path?.trim() || undefined)
    return c.json({
      success: true,
      available: isAdapterAvailable(adapterId),
      info: getCliPathInfo(adapterId),
    })
  })

  return router
}
