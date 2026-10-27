import {
  ProcessTransport,
  qodercliAuth,
  query,
  type ModelInfo,
  type SDKControlInitializeResponse,
} from '@qoder-ai/qoder-agent-sdk'
import type { RuntimeContext } from '../../context.js'
import { createRuntimeLogger } from '../../logger.js'
import { QODER_CLI_ID } from './config.js'

const logger = createRuntimeLogger('qoder-init')

/** The CLI's initialize response, shared by every Qoder provider and session of one runtime. */
interface QoderInitCache {
  info: SDKControlInitializeResponse | null
  fetching: Promise<void> | null
}

const initCache = (ctx: RuntimeContext): QoderInitCache =>
  ctx.shared<QoderInitCache>('qoder:init-info', () => ({ info: null, fetching: null }))

export const peekQoderInitInfo = (ctx: RuntimeContext): SDKControlInitializeResponse | null => initCache(ctx).info

async function doFetchInitInfo(ctx: RuntimeContext): Promise<void> {
  const cliPath = ctx.resolveBinary(QODER_CLI_ID)
  if (!cliPath) {
    logger.info('CLI not available, skipping init info fetch')
    return
  }

  let q: ReturnType<typeof query> | null = null
  try {
    logger.info('Fetching init info from CLI...')
    q = query({
      prompt: '',
      options: {
        auth: qodercliAuth(),
        transport: ProcessTransport.default,
        pathToQoderCLIExecutable: cliPath,
        env: ctx.env(),
        persistSession: false,
        settingSources: ['user', 'project'],
      },
    })

    const init = await q.initializationResult()
    initCache(ctx).info = init
    logger.info(`Init info fetched: ${init.models?.length ?? 0} models, account: ${init.account?.email ?? 'unknown'}`)
  } catch (err) {
    logger.error(`Failed to fetch init info: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await q?.close().catch(() => {})
  }
}

/** Run the init handshake once per runtime; concurrent callers share the one in flight. */
export async function fetchQoderInitInfo(ctx: RuntimeContext): Promise<void> {
  const cache = initCache(ctx)
  if (cache.info) return
  if (cache.fetching) return cache.fetching

  cache.fetching = doFetchInitInfo(ctx)
  try {
    await cache.fetching
  } finally {
    cache.fetching = null
  }
}

/**
 * The models this account can run. The catalog lists every model with
 * `isEnabled: false` on the ones the plan does not include (a Free account gets
 * two of fifteen); offering those would only fail on send.
 */
export function usableQoderModels(info: SDKControlInitializeResponse | null): ModelInfo[] {
  const models = info?.models ?? []
  const enabled = models.filter((m) => m.isEnabled !== false)
  return enabled.length > 0 ? enabled : models
}

/** The model the CLI starts on when none is chosen. */
export function defaultQoderModelId(info: SDKControlInitializeResponse | null): string | undefined {
  const models = usableQoderModels(info)
  return (models.find((m) => m.isDefault) ?? models[0])?.value
}

export function findQoderModel(ctx: RuntimeContext, modelId: string): ModelInfo | undefined {
  const info = peekQoderInitInfo(ctx)
  const id = modelId || defaultQoderModelId(info)
  return info?.models?.find((m) => m.value === id)
}
