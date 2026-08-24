import type { ProviderDescriptor, ProviderInfo, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import { applyRuntimeEnv } from '../../runtime-env.js'
import { AcpRuntimeSession, buildAcpDescriptor, probeAcpModels } from '../acp/index.js'
import { GROK_CONFIG } from './config.js'

export class GrokRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'grok',
    label: 'Grok',
    logo: 'grok',
  }

  readonly providerInfo = GrokRuntimeProvider.providerInfo
  private currentModelId = GROK_CONFIG.defaultModelId
  private currentModeId = GROK_CONFIG.defaultModeId

  async getDescriptor(): Promise<ProviderDescriptor> {
    applyRuntimeEnv()
    const ctx = await probeAcpModels(GROK_CONFIG)
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
    return new AcpRuntimeSession(params, GROK_CONFIG)
  }
}
