import type { ProviderDescriptor, ProviderInfo, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import { applyRuntimeEnv } from '../../runtime-env.js'
import { AcpRuntimeSession, buildAcpDescriptor, probeAcpModels } from '../acp/index.js'
import { KIMI_CONFIG } from './config.js'

export class KimiRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'kimi',
    label: 'Kimi Code',
    logo: 'moonshot',
  }

  readonly providerInfo = KimiRuntimeProvider.providerInfo
  private currentModelId = KIMI_CONFIG.defaultModelId
  private currentModeId = KIMI_CONFIG.defaultModeId

  async getDescriptor(): Promise<ProviderDescriptor> {
    applyRuntimeEnv()
    const ctx = await probeAcpModels(KIMI_CONFIG)
    const { models, currentModelId } = KIMI_CONFIG.extractModels(ctx, this.currentModelId)
    this.currentModelId = currentModelId
    return buildAcpDescriptor(
      KIMI_CONFIG,
      { models, currentModelId, currentModeId: this.currentModeId },
      ctx,
    )
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    if (params.modelId) this.currentModelId = params.modelId
    if (params.modeId) this.currentModeId = params.modeId
    return new AcpRuntimeSession(params, KIMI_CONFIG)
  }
}
