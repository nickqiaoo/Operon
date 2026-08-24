import { Hono } from 'hono'
import type {
  AgentBindingStorageAdapter,
  IMStorageAdapter,
  StorageAdapter,
} from '../storage/interface.js'
import type {
  CreateIMProviderInput,
  IMSource,
  UpdateIMProviderInput,
} from '../types/im.js'
import type { IMProviderRegistry } from '../gateway/im/registry.js'
import { listIMSourceMeta } from '../gateway/im/source-meta.js'
import { buildSlackManifest } from '../gateway/im/providers/slack/manifest.js'
import {
  applyBotDefaults as applyTelegramBotDefaults,
  validateBotToken as validateTelegramBotToken,
} from '../gateway/im/providers/telegram/quick-setup.js'

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'bot'
}

function generateInstanceId(
  storage: IMStorageAdapter & AgentBindingStorageAdapter,
  source: IMSource,
  displayName: string,
): string {
  const base = slugify(displayName).slice(0, 40) || 'bot'
  let candidate = base
  let n = 2
  while (storage.getIMProviderByInstance(source, candidate)) {
    candidate = `${base}-${n++}`
    if (n > 999) {
      candidate = `${base}-${Date.now().toString(36)}`
      break
    }
  }
  return candidate
}

export function adminIMRoutes(
  storage: IMStorageAdapter & AgentBindingStorageAdapter & StorageAdapter,
  registry: IMProviderRegistry,
) {
  const router = new Hono()

  router.get('/sources', (c) => {
    return c.json({ sources: listIMSourceMeta() })
  })

  router.get('/providers', (c) => {
    const source = c.req.query('source') as IMSource | undefined
    const enabledRaw = c.req.query('enabled')
    const enabled = enabledRaw === 'true' ? true : enabledRaw === 'false' ? false : undefined
    return c.json({ providers: storage.listIMProviders({ source, enabled }) })
  })

  router.get('/providers/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const provider = storage.getIMProvider(id)
    if (!provider) return c.json({ error: 'Not found' }, 404)
    return c.json({ provider })
  })

  router.post('/providers', async (c) => {
    const input = await c.req.json<Partial<CreateIMProviderInput>>()
    if (!input.source || !input.mode || !input.displayName || !input.credentialsJson) {
      return c.json({ error: 'source, mode, displayName and credentialsJson are required' }, 400)
    }
    const instanceId = input.instanceId?.trim() || generateInstanceId(storage, input.source, input.displayName)
    const provider = storage.createIMProvider({
      source: input.source,
      instanceId,
      mode: input.mode,
      agentId: input.agentId ?? null,
      selfUserId: input.selfUserId ?? '',
      selfBotId: input.selfBotId ?? null,
      displayName: input.displayName,
      credentialsJson: input.credentialsJson,
      configJson: input.configJson ?? null,
      enabled: input.enabled !== false,
    })
    if (provider.enabled) {
      await registry.startOne(provider).catch((err) => {
        console.error('[admin-im] startOne failed:', err)
      })
    }
    return c.json({ provider }, 201)
  })

  router.put('/providers/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const raw = await c.req.json<UpdateIMProviderInput & { source?: IMSource; mode?: string }>()
    if ('source' in raw || 'mode' in raw) {
      return c.json({ error: 'source and mode cannot be changed after creation — delete and recreate instead' }, 400)
    }
    const updates: UpdateIMProviderInput = raw
    storage.updateIMProvider(id, updates)
    const provider = storage.getIMProvider(id)
    if (!provider) return c.json({ error: 'Not found' }, 404)

    await registry.stopOne(id).catch(() => {})
    if (provider.enabled) {
      await registry.startOne(provider).catch((err) => {
        console.error('[admin-im] restart failed:', err)
      })
    }
    return c.json({ provider })
  })

  router.delete('/providers/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    await registry.stopOne(id).catch(() => {})
    storage.deleteIMProvider(id)
    return c.json({ success: true })
  })

  router.get('/bindings', (c) => {
    const agentIdRaw = c.req.query('agentId')
    const providerIdRaw = c.req.query('providerId')
    const source = c.req.query('source') as IMSource | undefined
    const sourceChannel = c.req.query('sourceChannel')

    if (agentIdRaw) {
      const agentId = parseInt(agentIdRaw, 10)
      const bindings = storage
        .listBindings({ agentId })
        .filter((b) => b.scopeKind === 'slack' || b.scopeKind === 'telegram')
      return c.json({ bindings })
    }
    if (providerIdRaw) {
      return c.json({
        bindings: storage.listBindings({ imProviderInstanceId: parseInt(providerIdRaw, 10) }),
      })
    }
    if (source && sourceChannel) {
      return c.json({
        bindings: storage.listBindingsForScope(source as 'slack' | 'telegram', sourceChannel),
      })
    }
    return c.json({ error: 'specify agentId, providerId, or (source + sourceChannel)' }, 400)
  })

  router.get('/messages', (c) => {
    const source = c.req.query('source') as IMSource | undefined
    const sourceChannel = c.req.query('sourceChannel')
    if (!source || !sourceChannel) {
      return c.json({ error: 'source and sourceChannel required' }, 400)
    }
    const afterId = c.req.query('afterId') ? parseInt(c.req.query('afterId')!, 10) : undefined
    const beforeId = c.req.query('beforeId') ? parseInt(c.req.query('beforeId')!, 10) : undefined
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined
    return c.json({
      messages: storage.listIMMessages(source, sourceChannel, { afterId, beforeId, limit }),
    })
  })

  // ---- Slack Quick Setup ----

  // Returns the app manifest for the user to paste into Slack's
  // "Create New App -> From a manifest" flow. We deliberately do NOT create the
  // app for them via apps.manifest.create: that requires a workspace config
  // token, which is an extra credential the user has to mint, expires in ~12h,
  // and is not how anyone actually creates a Slack bot.
  router.post('/slack/quick-setup/manifest', async (c) => {
    const body = await c.req.json<{ displayName?: string; description?: string }>()
    const displayName = body.displayName?.trim()
    if (!displayName) return c.json({ error: 'displayName is required' }, 400)
    const manifest = buildSlackManifest({ displayName, description: body.description })
    return c.json({ manifest: JSON.stringify(manifest, null, 2) })
  })

  // ---- Telegram Quick Setup ----

  router.post('/telegram/quick-setup/validate-token', async (c) => {
    const body = await c.req.json<{ token?: string }>()
    const token = body.token?.trim()
    if (!token) return c.json({ error: 'token is required' }, 400)
    try {
      const info = await validateTelegramBotToken(token)
      return c.json({ bot: info })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  router.post('/telegram/quick-setup/recheck/:providerId', async (c) => {
    const providerId = parseInt(c.req.param('providerId'), 10)
    const record = storage.getIMProvider(providerId)
    if (!record) return c.json({ error: 'Provider not found' }, 404)
    if (record.source !== 'telegram') return c.json({ error: 'Provider is not Telegram' }, 400)
    let token: string | undefined
    try {
      const creds = JSON.parse(record.credentialsJson) as { botToken?: string }
      token = creds.botToken
    } catch {
      return c.json({ error: 'Stored credentials are not valid JSON' }, 500)
    }
    if (!token) return c.json({ error: 'Stored credentials missing botToken' }, 500)
    try {
      const info = await validateTelegramBotToken(token)
      return c.json({ bot: info })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  router.post('/telegram/quick-setup/create-provider', async (c) => {
    const body = await c.req.json<{
      token?: string
      displayName?: string
      description?: string
      mode?: 'mate' | 'interactive'
      agentId?: number | null
    }>()
    const token = body.token?.trim()
    const displayName = body.displayName?.trim()
    const mode = body.mode ?? 'mate'
    if (!token) return c.json({ error: 'token is required' }, 400)
    if (!displayName) return c.json({ error: 'displayName is required' }, 400)
    if (mode === 'mate' && !body.agentId) return c.json({ error: 'mate mode requires agentId' }, 400)
    if (mode === 'interactive' && body.agentId) return c.json({ error: 'interactive mode must not have agentId' }, 400)

    let info
    try {
      info = await validateTelegramBotToken(token)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }

    // Apply default config — best-effort; surface failure but don't abort
    // provider creation since the token is already validated and stored.
    let applyWarning: string | null = null
    try {
      await applyTelegramBotDefaults(token, {
        displayName,
        description: body.description?.slice(0, 512),
      })
    } catch (err) {
      applyWarning = err instanceof Error ? err.message : String(err)
      console.warn('[admin-im] telegram applyBotDefaults failed:', applyWarning)
    }

    const instanceId = generateInstanceId(storage, 'telegram', displayName)
    const provider = storage.createIMProvider({
      source: 'telegram',
      instanceId,
      mode,
      agentId: mode === 'mate' ? body.agentId ?? null : null,
      selfUserId: String(info.id),
      selfBotId: null,
      displayName,
      credentialsJson: JSON.stringify({ botToken: token }),
      configJson: null,
      enabled: true,
    })
    await registry.startOne(provider).catch((err) => {
      console.error('[admin-im] telegram startOne failed:', err)
    })

    return c.json({
      provider,
      bot: info,
      applyWarning,
    }, 201)
  })

  return router
}
