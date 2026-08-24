import type { ProviderDescriptor, ProviderInfo, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import { AcpRuntimeSession, buildAcpDescriptor, probeAcpModels } from '../acp/index.js'
import { CURSOR_CONFIG } from './config.js'

export class CursorRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'cursor',
    label: 'Cursor',
    logo: 'cursor',
  }

  readonly providerInfo = CursorRuntimeProvider.providerInfo
  private currentModelId = CURSOR_CONFIG.defaultModelId
  private currentModeId = CURSOR_CONFIG.defaultModeId

  async getDescriptor(): Promise<ProviderDescriptor> {
    const ctx = await probeAcpModels(CURSOR_CONFIG)
    const { models, currentModelId } = CURSOR_CONFIG.extractModels(ctx, this.currentModelId)
    this.currentModelId = currentModelId
    return buildAcpDescriptor(
      CURSOR_CONFIG,
      { models, currentModelId, currentModeId: this.currentModeId },
      ctx,
    )
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    if (params.modelId) this.currentModelId = params.modelId
    if (params.modeId) this.currentModeId = params.modeId
    return new AcpRuntimeSession(params, CURSOR_CONFIG)
  }
}
