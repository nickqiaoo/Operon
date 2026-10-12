import { defineProvider } from '../../runtime.js'
import type { RuntimeContext } from '../../context.js'
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

  constructor(private readonly ctx: RuntimeContext) {}

  private currentModelId = CURSOR_CONFIG.defaultModelId
  private currentModeId = CURSOR_CONFIG.defaultModeId

  async getDescriptor(): Promise<ProviderDescriptor> {
    const ctx = await probeAcpModels(this.ctx, CURSOR_CONFIG)
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
    return new AcpRuntimeSession(params, CURSOR_CONFIG, this.ctx)
  }
}

/** Modes known today; an ACP agent may announce others at runtime. */
export type CursorMode = 'agent' | 'ask' | 'plan' | (string & {})

/** Cursor, driven over ACP (`cursor-agent acp`). */
export const cursor = () =>
  defineProvider<'cursor', { mode: CursorMode; effort: never }>({
    id: 'cursor',
    info: CursorRuntimeProvider.providerInfo,
    create: (ctx) => new CursorRuntimeProvider(ctx),
  })
