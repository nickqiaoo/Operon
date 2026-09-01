import { getRuntimeHost } from '../../host.js'
import type { ProviderDescriptor, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import type { ProviderInfo } from '../../types.js'
import { buildRuntimeEnv } from '../../runtime-env.js'
import { CODEX_DEFAULT_MODE_ID, resolveCodexModeId } from './config.js'
import { listSkills } from './sdk/discovery.js'
import {
  type CodexModelState,
  CodexRuntimeSession,
  DEFAULT_CODEX_MODEL_ID,
  refreshCodexModels,
} from './session.js'

export class CodexRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = { id: 'codex', label: 'Codex', logo: 'openai' }
  readonly providerInfo = CodexRuntimeProvider.providerInfo

  private static modelState: CodexModelState = {
    models: [],
    thinkingLevels: [],
    currentModelId: DEFAULT_CODEX_MODEL_ID,
    currentThinkingLevel: undefined,
    hasLoaded: false,
    refreshInFlight: null,
  }

  private currentModeId = CODEX_DEFAULT_MODE_ID
  private currentThinkingLevel: string | undefined
  private currentServiceTier: ProviderDescriptor['currentServiceTier']
  private cwd = process.cwd()

  async getDescriptor(): Promise<ProviderDescriptor> {
    await refreshCodexModels(CodexRuntimeProvider.modelState)
    let slashCommands = [] as ProviderDescriptor['slashCommands']
    try {
      const codexPath = getRuntimeHost().resolveCliPath('codex')
      if (codexPath) {
        const skills = await listSkills({ codexPath, cwds: [this.cwd], env: buildRuntimeEnv() })
        slashCommands = skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          type: 'skill' as const,
        }))
      }
    } catch {
      slashCommands = []
    }

    ;(slashCommands ??= []).push({ name: 'compact', description: 'Compact conversation history', type: 'command' })

    return {
      id: 'codex',
      label: 'Codex',
      logo: 'openai',
      models: CodexRuntimeProvider.modelState.models,
      modes: [
        {
          id: 'requestApproval',
          name: 'Request Approval',
          description: 'Ask before external file edits and network access',
        },
        {
          id: 'approveForMe',
          name: 'Approve for Me',
          description: 'Only ask for detected risky operations',
        },
        {
          id: 'fullAccess',
          name: 'Full Access',
          description: 'Allow unrestricted network and file access',
        },
        {
          id: 'plan',
          name: 'Plan',
          description: 'Plan mode - create a plan before execution',
        },
      ],
      thinkingLevels: CodexRuntimeProvider.modelState.thinkingLevels,
      serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Prioritize faster responses' }],
      commands: [],
      slashCommands,
      currentModelId: CodexRuntimeProvider.modelState.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel ?? CodexRuntimeProvider.modelState.currentThinkingLevel,
      currentServiceTier: this.currentServiceTier,
      features: {
        permissions: true,
        attachments: true,
        injection: true,
        sessionResume: true,
        goal: true,
        sideChat: true,
      },
    }
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    this.cwd = params.cwd
    if (params.modeId) this.currentModeId = resolveCodexModeId(params.modeId)
    if (params.thinkingLevel) this.currentThinkingLevel = params.thinkingLevel
    this.currentServiceTier = params.serviceTier
    return new CodexRuntimeSession(params)
  }
}
