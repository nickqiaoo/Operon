import { defineProvider } from '../../runtime.js'
import type { RuntimeContext } from '../../context.js'
import type { AgentSession, ProviderDescriptor, ProviderInfo, RuntimeProviderFactory, SessionOptions } from '../../types.js'
import { AcpRuntimeSession, buildAcpDescriptor, probeAcpModels } from '../acp/index.js'
import { ANTIGRAVITY_CONFIG } from './config.js'

export class AntigravityRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'antigravity',
    label: 'Antigravity',
    logo: 'antigravity',
  }

  readonly providerInfo = AntigravityRuntimeProvider.providerInfo

  constructor(private readonly ctx: RuntimeContext) {}

  private currentModelId = ANTIGRAVITY_CONFIG.defaultModelId
  private currentModeId = ANTIGRAVITY_CONFIG.defaultModeId

  async getDescriptor(): Promise<ProviderDescriptor> {
    const ctx = await probeAcpModels(this.ctx, ANTIGRAVITY_CONFIG)
    const { models, currentModelId } = ANTIGRAVITY_CONFIG.extractModels(ctx, this.currentModelId)
    this.currentModelId = currentModelId
    return buildAcpDescriptor(
      ANTIGRAVITY_CONFIG,
      { models, currentModelId, currentModeId: this.currentModeId },
      ctx,
    )
  }

  async createSession(params: SessionOptions): Promise<AgentSession> {
    if (params.model) this.currentModelId = params.model
    if (params.mode) this.currentModeId = params.mode
    return new AcpRuntimeSession(params, ANTIGRAVITY_CONFIG, this.ctx)
  }
}

/** Modes known today; an ACP agent may announce others at runtime. */
export type AntigravityMode = 'default' | 'auto_edit' | 'yolo' | (string & {})

/** Antigravity, driven over ACP (`agy_acp_server`). */
export const antigravity = () =>
  defineProvider<'antigravity', { mode: AntigravityMode; effort: string }>({
    id: 'antigravity',
    info: AntigravityRuntimeProvider.providerInfo,
    create: (ctx) => new AntigravityRuntimeProvider(ctx),
  })
