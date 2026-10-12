import { defineProvider } from '../../runtime.js'
import type { CodexModeId } from './config.js'
import type { AccountRateLimitsReadResult } from './sdk/protocol/index.js'
import { getCodexAccountUsage } from './usage-probe.js'
import type { RuntimeContext } from '../../context.js'
import type { ProviderDescriptor, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import type { ProviderInfo } from '../../types.js'
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

  /** The live model list, shared by every provider instance of one runtime. */
  private readonly modelState: CodexModelState

  constructor(private readonly ctx: RuntimeContext) {
    this.modelState = ctx.shared<CodexModelState>('codex:models', () => ({
      models: [],
      thinkingLevels: [],
      currentModelId: DEFAULT_CODEX_MODEL_ID,
      currentThinkingLevel: undefined,
      hasLoaded: false,
      refreshInFlight: null,
    }))
  }

  private currentModeId = CODEX_DEFAULT_MODE_ID
  private currentThinkingLevel: string | undefined
  private currentServiceTier: ProviderDescriptor['currentServiceTier']
  private cwd = process.cwd()

  async getDescriptor(): Promise<ProviderDescriptor> {
    await refreshCodexModels(this.ctx, this.modelState)
    let slashCommands = [] as ProviderDescriptor['slashCommands']
    try {
      const codexPath = this.ctx.resolveBinary('codex')
      if (codexPath) {
        const skills = await listSkills({ codexPath, cwds: [this.cwd], env: this.ctx.env() })
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
      models: this.modelState.models,
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
      thinkingLevels: this.modelState.thinkingLevels,
      serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Prioritize faster responses' }],
      commands: [],
      slashCommands,
      currentModelId: this.modelState.currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel ?? this.modelState.currentThinkingLevel,
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
    return new CodexRuntimeSession(params, this.ctx)
  }
}

/** Codex extras that need no session. */
export interface CodexNative {
  /**
   * Every rate-limit bucket on the signed-in account; null when Codex cannot
   * answer. `maxAgeMs` bounds how stale a cached read may be (0 = read now).
   */
  accountUsage(maxAgeMs?: number): Promise<AccountRateLimitsReadResult | null>
}

/** Effort ids Codex models advertise today; the live list comes from the model. */
export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | (string & {})

/** Codex, driven through `codex app-server`. */
export const codex = () =>
  defineProvider<'codex', { mode: CodexModeId; effort: CodexEffort; native: CodexNative }>({
    id: 'codex',
    info: CodexRuntimeProvider.providerInfo,
    create: (ctx) => new CodexRuntimeProvider(ctx),
    native: (ctx) => ({
      accountUsage: (maxAgeMs) => getCodexAccountUsage(ctx, maxAgeMs),
    }),
  })
