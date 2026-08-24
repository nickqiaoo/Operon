import type { ProviderDescriptor, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import type { ProviderInfo } from '../../types.js'
import { listSkills } from './config.js'
import { GeminiRuntimeSession } from './session.js'

export class GeminiRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'gemini',
    label: 'Gemini CLI',
    logo: 'google',
  }

  readonly providerInfo = GeminiRuntimeProvider.providerInfo
  private currentModelId = 'gemini-3-pro-preview'
  private currentModeId = 'Default'
  private cwd = process.cwd()

  async getDescriptor(): Promise<ProviderDescriptor> {
    let slashCommands = [] as ProviderDescriptor['slashCommands']
    try {
      const skills = await listSkills(this.cwd)
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
      id: 'gemini',
      label: 'Gemini CLI',
      logo: 'google',
      models: [
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'Latest preview for complex tasks' },
        { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', description: 'Latest preview for complex tasks' },
        { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', description: 'Latest preview for speed' },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Stable for advanced reasoning' },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Stable for low latency' },
      ],
      modes: [
        { id: 'Default', name: 'Default', description: 'Confirm edits and commands' },
        { id: 'AutoEdit', name: 'Auto Edit', description: 'Auto-approve edits, confirm commands' },
        { id: 'FullAccess', name: 'Full Access', description: 'No confirmations' },
      ],
      commands: [],
      slashCommands,
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
      features: {
        permissions: true,
        attachments: true,
        injection: true,
        sessionResume: true,
      },
    }
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    this.cwd = params.cwd
    if (params.modelId) this.currentModelId = params.modelId
    if (params.modeId) this.currentModeId = params.modeId
    return new GeminiRuntimeSession(params)
  }
}
