import { defineProvider } from '../../runtime.js'
import type { RuntimeContext } from '../../context.js'
import type { ProviderDescriptor, ProviderInfo, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import { AcpRuntimeSession, buildAcpDescriptor, probeAcpModels } from '../acp/index.js'
import { GROK_CONFIG } from './config.js'

export class GrokRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'grok',
    label: 'Grok',
    logo: 'grok',
  }

  readonly providerInfo = GrokRuntimeProvider.providerInfo

  constructor(private readonly ctx: RuntimeContext) {}

  private currentModelId = GROK_CONFIG.defaultModelId
  private currentModeId = GROK_CONFIG.defaultModeId

  async getDescriptor(): Promise<ProviderDescriptor> {
    const ctx = await probeAcpModels(this.ctx, GROK_CONFIG)
    const { models, currentModelId } = GROK_CONFIG.extractModels(ctx, this.currentModelId)
    this.currentModelId = currentModelId
    return buildAcpDescriptor(
      GROK_CONFIG,
      { models, currentModelId, currentModeId: this.currentModeId },
      ctx,
    )
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    if (params.modelId) this.currentModelId = params.modelId
    if (params.modeId) this.currentModeId = params.modeId
    return new AcpRuntimeSession(params, GROK_CONFIG, this.ctx)
  }
}

/** Modes known today; an ACP agent may announce others at runtime. */
export type GrokMode = 'default' | 'auto' | 'plan' | 'bypassPermissions' | (string & {})

/** Grok, driven over ACP. */
export const grok = () =>
  defineProvider<'grok', { mode: GrokMode; effort: never }>({
    id: 'grok',
    info: GrokRuntimeProvider.providerInfo,
    create: (ctx) => new GrokRuntimeProvider(ctx),
  })
