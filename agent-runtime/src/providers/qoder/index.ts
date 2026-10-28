import { defineProvider } from '../../runtime.js'
import type { RuntimeContext } from '../../context.js'
import type {
  EffortLevel,
  Model,
  ProviderDescriptor,
  ProviderInfo,
  RuntimeProviderFactory,
  SessionOptions,
} from '../../types.js'
import {
  DEFAULT_EFFORT,
  DEFAULT_MODE_ID,
  QODER_MODES,
  QODER_SLASH_COMMANDS,
  QODER_THINKING_LEVELS,
  resolveQoderEffort,
  resolveQoderMode,
  type QoderSessionOptions,
} from './config.js'
import { defaultQoderModelId, fetchQoderInitInfo, peekQoderInitInfo, usableQoderModels } from './init-info.js'
import { QoderRuntimeSession, type QoderSessionNative } from './session.js'
import type { QoderEffort, QoderMode } from './types.js'

const EFFORT_LEVELS = new Set<string>(QODER_THINKING_LEVELS?.map((level) => level.id))

export class QoderRuntimeProvider implements RuntimeProviderFactory<SessionOptions & QoderSessionOptions, QoderSessionNative> {
  static readonly providerInfo: ProviderInfo = {
    id: 'qoder',
    label: 'Qoder',
    logo: 'qoder',
  }

  readonly providerInfo = QoderRuntimeProvider.providerInfo

  constructor(private readonly ctx: RuntimeContext) {}

  /** Empty = the account's default model. */
  private currentModelId = ''
  private currentModeId: QoderMode = DEFAULT_MODE_ID
  private currentEffort: QoderEffort = DEFAULT_EFFORT

  async fetchInitInfo(): Promise<void> {
    await fetchQoderInitInfo(this.ctx)
  }

  async getDescriptor(): Promise<ProviderDescriptor> {
    const initInfo = peekQoderInitInfo(this.ctx)

    // Live list from the CLI handshake: the catalog is per account and changes
    // server-side, so there is no static fallback table.
    const models: Model[] = usableQoderModels(initInfo).map((m) => ({
      id: m.value,
      name: m.displayName,
      ...(m.description ? { description: m.description } : {}),
      supportedEffortLevels: (m.efforts ?? []).filter((e): e is EffortLevel => EFFORT_LEVELS.has(e)),
      ...(m.defaultContextWindow ? { contextWindow: m.defaultContextWindow } : {}),
    }))

    const knownIds = new Set(models.map((m) => m.id))
    if (!knownIds.has(this.currentModelId)) {
      this.currentModelId = defaultQoderModelId(initInfo) ?? this.currentModelId
    }

    const slashCommands: ProviderDescriptor['slashCommands'] = (() => {
      const seen = new Set<string>()
      const items: NonNullable<ProviderDescriptor['slashCommands']> = []
      for (const cmd of initInfo?.commands ?? []) {
        if (!cmd.name || seen.has(cmd.name)) continue
        seen.add(cmd.name)
        items.push({ name: cmd.name, description: cmd.description ?? '', type: 'command' })
      }
      return items.length > 0 ? items : QODER_SLASH_COMMANDS
    })()

    const account = initInfo?.account
      ? {
          email: initInfo.account.email,
          subscriptionType: initInfo.account.subscriptionType,
        }
      : undefined

    return {
      ...QoderRuntimeProvider.providerInfo,
      models,
      modes: QODER_MODES,
      thinkingLevels: QODER_THINKING_LEVELS,
      commands: [],
      slashCommands,
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentEffort,
      features: {
        permissions: true,
        attachments: true,
        injection: true,
        sessionResume: true,
        dynamicSwitch: true,
        contextUsage: true,
        sideChat: true,
      },
      account,
    }
  }

  async createSession(params: SessionOptions & QoderSessionOptions): Promise<QoderRuntimeSession> {
    if (params.model) this.currentModelId = params.model
    if (params.mode) this.currentModeId = resolveQoderMode(params.mode)
    if (params.effort) this.currentEffort = resolveQoderEffort(params.effort)
    // The session clamps effort to what the model supports, which needs the catalog.
    await fetchQoderInitInfo(this.ctx)
    return new QoderRuntimeSession(params, this.ctx)
  }
}

/** Qoder, driven through `@qoder-ai/qoder-agent-sdk` and the user's own `qodercli`. */
export const qoder = () =>
  defineProvider<'qoder', {
    mode: QoderMode
    effort: QoderEffort
    sessionNative: QoderSessionNative
  }>({
    id: 'qoder',
    info: QoderRuntimeProvider.providerInfo,
    create: (ctx) => new QoderRuntimeProvider(ctx),
  })
