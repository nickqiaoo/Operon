import { defineProvider } from '../../runtime.js'
import type { EffortLevel, Model, ProviderDescriptor, RuntimeProviderFactory, SessionOptions } from '../../types.js'
import type { ProviderInfo } from '../../types.js'
import type { RuntimeContext } from '../../context.js'
import { OpencodeClientManager } from './client-manager.js'
import {
  listOpencodeDescriptorModels,
  OpencodeRuntimeSession,
  type OpencodeSessionNative,
  type OpencodeSessionOptions,
} from './session.js'

export class OpencodeRuntimeProvider
  implements RuntimeProviderFactory<SessionOptions & OpencodeSessionOptions, OpencodeSessionNative>
{
  static readonly providerInfo: ProviderInfo = {
    id: 'opencode',
    label: 'OpenCode',
    logo: 'opencode',
  }

  readonly providerInfo = OpencodeRuntimeProvider.providerInfo

  constructor(private readonly ctx: RuntimeContext) {}

  private currentModelId = 'opencode/big-pickle'
  private currentModeId = 'build'
  private currentThinkingLevel: string | undefined
  private cwd = process.cwd()

  async getDescriptor(): Promise<ProviderDescriptor> {
    // Live list from the OpenCode provider API only — no static model table.
    const { models, currentModelId } = await listOpencodeDescriptorModels(this.ctx, this.cwd, this.currentModelId).catch(() => ({
      models: [] as Model[],
      currentModelId: this.currentModelId,
    }))
    this.currentModelId = currentModelId

    let slashCommands = [] as ProviderDescriptor['slashCommands']
    try {
      const clientManager = OpencodeClientManager.getInstance(this.ctx, {
        autoStartServer: true,
        cwd: this.cwd,
      })
      const [skills, commands] = await Promise.all([
        clientManager.listSkills(this.cwd), clientManager.listCommands(this.cwd),
      ])
      const entries: ProviderDescriptor['slashCommands'] = skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        type: 'skill' as const,
      }))
      entries.push(...commands.map((command) => ({ name: command.name, description: command.description ?? '', type: 'command' as const })))
      slashCommands = [...new Map(entries.map((entry) => [entry.name, entry])).values()]
    } catch {
      slashCommands = []
    }

    slashCommands = slashCommands.filter((entry) => entry.name !== 'compact')
    slashCommands.push({
      name: 'compact',
      description: 'Compact conversation history',
      type: 'command',
    })

    return {
      id: 'opencode',
      label: 'OpenCode',
      logo: 'opencode',
      models,
      thinkingLevels: ([...new Set(models.flatMap((model) => model.supportedEffortLevels ?? []))] as EffortLevel[]).map((id) => ({ id, name: id === 'xhigh' ? 'Extra High' : id[0].toUpperCase() + id.slice(1) })),
      modes: [
        { id: 'build', name: 'Build', description: 'Building with approval requests' },
        { id: 'plan', name: 'Plan', description: 'Planning and analysis' },
        { id: 'fullAccess', name: 'Full Access', description: 'No approval needed' },
      ],
      commands: slashCommands.filter((entry) => entry.type === 'command').map((entry) => ({ id: entry.name, name: entry.name, description: entry.description })),
      slashCommands,
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel,
      features: {
        permissions: true,
        attachments: true,
        injection: true,
        sessionResume: true,
        sideChat: true,
        dynamicSwitch: true,
        contextUsage: true,
      },
    }
  }

  async createSession(params: SessionOptions & OpencodeSessionOptions): Promise<OpencodeRuntimeSession> {
    this.cwd = params.cwd
    if (params.model) this.currentModelId = params.model
    if (params.mode) this.currentModeId = params.mode
    if (params.effort) this.currentThinkingLevel = params.effort
    return new OpencodeRuntimeSession(params, this.ctx)
  }
}

export type OpencodeMode = 'build' | 'plan' | 'fullAccess'

/** OpenCode, driven through one `opencode serve` shared by the runtime's sessions. */
export const opencode = () =>
  defineProvider<'opencode', {
    mode: OpencodeMode
    effort: EffortLevel
    options: OpencodeSessionOptions
    sessionNative: OpencodeSessionNative
  }>({
    id: 'opencode',
    info: OpencodeRuntimeProvider.providerInfo,
    create: (ctx) => new OpencodeRuntimeProvider(ctx),
  })
