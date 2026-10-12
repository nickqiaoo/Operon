import { defineProvider } from '../../runtime.js'
import type { ProviderDescriptor, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import type { ProviderInfo } from '../../types.js'
import type { RuntimeContext } from '../../context.js'
import { OpencodeClientManager } from './client-manager.js'
import { listOpencodeDescriptorModels, OpencodeRuntimeSession } from './session.js'

export class OpencodeRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'opencode',
    label: 'OpenCode',
    logo: 'opencode',
  }

  readonly providerInfo = OpencodeRuntimeProvider.providerInfo

  constructor(private readonly ctx: RuntimeContext) {}

  private currentModelId = 'opencode/big-pickle'
  private currentModeId = 'build'
  private cwd = process.cwd()

  async getDescriptor(): Promise<ProviderDescriptor> {
    // Live list from the OpenCode provider API only — no static model table.
    const { models, currentModelId } = await listOpencodeDescriptorModels(this.ctx, this.cwd, this.currentModelId).catch(() => ({
      models: [] as Array<{ id: string; name: string; description?: string }>,
      currentModelId: this.currentModelId,
    }))
    this.currentModelId = currentModelId

    let slashCommands = [] as ProviderDescriptor['slashCommands']
    try {
      const clientManager = OpencodeClientManager.getInstance(this.ctx, {
        autoStartServer: true,
        cwd: this.cwd,
      })
      const skills = await clientManager.listSkills(this.cwd)
      slashCommands = skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        type: 'skill' as const,
      }))
    } catch {
      slashCommands = []
    }

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
      modes: [
        { id: 'build', name: 'Build', description: 'Building with approval requests' },
        { id: 'plan', name: 'Plan', description: 'Planning and analysis' },
        { id: 'fullAccess', name: 'Full Access', description: 'No approval needed' },
      ],
      commands: [],
      slashCommands,
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      features: {
        permissions: true,
        attachments: false,
        injection: true,
        sessionResume: true,
        sideChat: true,
      },
    }
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    this.cwd = params.cwd
    if (params.modelId) this.currentModelId = params.modelId
    if (params.modeId) this.currentModeId = params.modeId
    return new OpencodeRuntimeSession(params, this.ctx)
  }
}

export type OpencodeMode = 'build' | 'plan' | 'fullAccess'

/** OpenCode, driven through one `opencode serve` shared by the runtime's sessions. */
export const opencode = () =>
  defineProvider<'opencode', { mode: OpencodeMode; effort: never }>({
    id: 'opencode',
    info: OpencodeRuntimeProvider.providerInfo,
    create: (ctx) => new OpencodeRuntimeProvider(ctx),
  })
