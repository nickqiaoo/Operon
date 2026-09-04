import { Hono } from 'hono'
import {
  INSTALLABLE_ACP_AGENTS,
  findInstallableAgent,
  getInstallProgress,
  installAcpAgent,
  readInstalledMarker,
  registryPlatformKey,
  uninstallAcpAgent,
} from '../services/acp-agent-install.js'
import {
  getAntigravityAuthStatus,
  setAntigravityAuthType,
  type AntigravityAuthType,
} from '../services/antigravity-auth.js'
import { getCliPathInfo } from '../services/adapter/bundled-cli-paths.js'
import { isCliAdapterId } from '../services/cli-path-config.js'

export function acpAgentRoutes() {
  const router = new Hono()

  /** What is installable here, what is installed, and where an install stands. */
  router.get('/', async (c) => {
    const platform = registryPlatformKey()
    const agents = await Promise.all(
      INSTALLABLE_ACP_AGENTS.map(async (agent) => ({
        id: agent.id,
        label: agent.label,
        // A null platform key means the registry ships no build for this
        // machine — an Intel Mac, today. The UI says so instead of offering a
        // button that could only fail.
        supported: platform !== null,
        platform,
        installed: await readInstalledMarker(agent.id),
        resolvedPath: isCliAdapterId(agent.id) ? getCliPathInfo(agent.id).resolvedPath : undefined,
        progress: getInstallProgress(agent.id),
      })),
    )
    return c.json({ agents })
  })

  /**
   * Whether Antigravity can be spawned without an unexplained browser window.
   * Its own, because sign-in is per agent — no other installable agent has one.
   */
  router.get('/antigravity/auth', async (c) => c.json(await getAntigravityAuthStatus()))

  router.put('/antigravity/auth', async (c) => {
    const body = await c.req.json<{ type?: string }>()
    const allowed: AntigravityAuthType[] = ['oauth-personal', 'gemini-api-key', 'oauth-business', 'agent-platform']
    if (!allowed.includes(body.type as AntigravityAuthType)) {
      return c.json({ error: `type must be one of: ${allowed.join(', ')}` }, 400)
    }
    return c.json(await setAntigravityAuthType(body.type as AntigravityAuthType))
  })

  router.get('/:id/progress', (c) => {
    const agent = findInstallableAgent(c.req.param('id'))
    if (!agent) return c.json({ error: 'Unknown agent' }, 404)
    return c.json(getInstallProgress(agent.id))
  })

  /**
   * Kick off an install and return immediately.
   *
   * Downloading and unpacking most of a gigabyte takes minutes, far past any
   * sensible request timeout, so the work runs detached and the client polls
   * `/progress`. A second POST while one is running is refused rather than
   * starting a competing download into the same directory.
   */
  router.post('/:id/install', (c) => {
    const agent = findInstallableAgent(c.req.param('id'))
    if (!agent) return c.json({ error: 'Unknown agent' }, 404)
    if (!registryPlatformKey()) {
      return c.json({ error: `No build available for ${process.platform}/${process.arch}` }, 400)
    }
    const current = getInstallProgress(agent.id).state
    if (current === 'downloading' || current === 'extracting' || current === 'installing') {
      return c.json({ error: 'An install is already running' }, 409)
    }
    void installAcpAgent(agent).catch((error) => {
      // Already recorded in the progress record the client is polling; this
      // keeps it in the log too.
      console.error(`[acp-agents] install of ${agent.id} failed:`, error)
    })
    return c.json({ started: true })
  })

  router.delete('/:id', async (c) => {
    const agent = findInstallableAgent(c.req.param('id'))
    if (!agent) return c.json({ error: 'Unknown agent' }, 404)
    await uninstallAcpAgent(agent.id)
    return c.json({ success: true })
  })

  return router
}
