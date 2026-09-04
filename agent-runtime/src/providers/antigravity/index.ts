import type { ProviderDescriptor, ProviderInfo, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import { applyRuntimeEnv } from '../../runtime-env.js'
import { AcpRuntimeSession, buildAcpDescriptor, probeAcpModels } from '../acp/index.js'
import { ANTIGRAVITY_CONFIG } from './config.js'

export class AntigravityRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'antigravity',
    label: 'Antigravity',
    logo: 'antigravity',
  }

  readonly providerInfo = AntigravityRuntimeProvider.providerInfo
  private currentModelId = ANTIGRAVITY_CONFIG.defaultModelId
  private currentModeId = ANTIGRAVITY_CONFIG.defaultModeId

  async getDescriptor(): Promise<ProviderDescriptor> {
    applyRuntimeEnv()
    const ctx = await probeAcpModels(ANTIGRAVITY_CONFIG)
    const { models, currentModelId } = ANTIGRAVITY_CONFIG.extractModels(ctx, this.currentModelId)
    this.currentModelId = currentModelId
    return buildAcpDescriptor(
      ANTIGRAVITY_CONFIG,
      { models, currentModelId, currentModeId: this.currentModeId },
      ctx,
    )
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    if (params.modelId) this.currentModelId = params.modelId
    if (params.modeId) this.currentModeId = params.modeId
    return new AcpRuntimeSession(params, ANTIGRAVITY_CONFIG)
  }
}
