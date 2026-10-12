import { defineProvider } from '../../runtime.js'
import type { RuntimeContext } from '../../context.js'
import type { ProviderDescriptor, ProviderInfo, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import { AcpRuntimeSession, buildAcpDescriptor, probeAcpModels } from '../acp/index.js'
import { KIMI_CONFIG } from './config.js'

export class KimiRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'kimi',
    label: 'Kimi Code',
    logo: 'moonshot',
  }

  readonly providerInfo = KimiRuntimeProvider.providerInfo

  constructor(private readonly ctx: RuntimeContext) {}

  private currentModelId = KIMI_CONFIG.defaultModelId
  private currentModeId = KIMI_CONFIG.defaultModeId

  async getDescriptor(): Promise<ProviderDescriptor> {
    const ctx = await probeAcpModels(this.ctx, KIMI_CONFIG)
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
    return new AcpRuntimeSession(params, KIMI_CONFIG, this.ctx)
  }
}

/** Modes known today; an ACP agent may announce others at runtime. */
export type KimiMode = 'default' | 'auto' | 'plan' | 'yolo' | (string & {})

/** Kimi Code, driven over ACP. */
export const kimi = () =>
  defineProvider<'kimi', { mode: KimiMode; effort: never }>({
    id: 'kimi',
    info: KimiRuntimeProvider.providerInfo,
    create: (ctx) => new KimiRuntimeProvider(ctx),
  })
