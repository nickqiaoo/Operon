import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { defineProvider } from '../../runtime.js'
import type { RuntimeUsageLimits } from '../../types.js'
import type { ClaudeThinkingLevel } from './types.js'
import { getClaudeAccountUsage, peekClaudeAccountUsage } from './usage-probe.js'
import { readClaudeSubagentTranscript, type ClaudeSubagentTranscript } from './subagent-transcript.js'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderDescriptor, RuntimeProviderFactory, RuntimeSession, RuntimeSessionParams } from '../../types.js'
import type { ProviderInfo } from '../../types.js'
import {
  CLAUDE_MODES,
  CLAUDE_SERVICE_TIERS,
  CLAUDE_SLASH_COMMANDS,
  CLAUDE_THINKING_LEVELS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODE_ID,
  DEFAULT_THINKING_LEVEL,
  normalizeModelId,
} from './config.js'
import type { Model } from '../../types.js'
import { ClaudeRuntimeSession } from './session.js'
import type { RuntimeContext } from '../../context.js'
import { createRuntimeLogger } from '../../logger.js'

const logger = createRuntimeLogger('claude-init')

/** Init info cache shared by every ClaudeRuntimeProvider instance of one runtime. */
interface ClaudeInitCache {
  info: SDKControlInitializeResponse | null
  fetching: Promise<void> | null
}

const initCache = (ctx: RuntimeContext): ClaudeInitCache =>
  ctx.shared<ClaudeInitCache>('claude-code:init-info', () => ({ info: null, fetching: null }))

async function doFetchInitInfo(ctx: RuntimeContext): Promise<void> {
  const cliPath = ctx.resolveBinary('claude-code')
  if (!cliPath) {
    logger.info('CLI not available, skipping init info fetch')
    return
  }

  let q: ReturnType<typeof query> | null = null
  try {
    logger.info('Fetching init info from CLI...')
    q = query({
      prompt: '',
      options: {
        pathToClaudeCodeExecutable: cliPath,
        persistSession: false,
        settingSources: ['user', 'project'],
      },
    })

    const init = await q.initializationResult()
    initCache(ctx).info = init
    logger.info(`Init info fetched: ${init.models?.length ?? 0} models, account: ${init.account?.email ?? 'unknown'}`)
  } catch (err) {
    logger.error(`Failed to fetch init info: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    try {
      q?.close()
    } catch {
      // ignore close errors
    }
  }
}

export class ClaudeRuntimeProvider implements RuntimeProviderFactory {
  static readonly providerInfo: ProviderInfo = {
    id: 'claude-code',
    label: 'Claude Code',
    logo: 'anthropic',
  }

  readonly providerInfo = ClaudeRuntimeProvider.providerInfo

  constructor(private readonly ctx: RuntimeContext) {}

  private currentModelId = DEFAULT_MODEL_ID
  private currentModeId = DEFAULT_MODE_ID
  private currentThinkingLevel = DEFAULT_THINKING_LEVEL

  async fetchInitInfo(): Promise<void> {
    const cache = initCache(this.ctx)
    if (cache.info) return
    if (cache.fetching) return cache.fetching

    cache.fetching = doFetchInitInfo(this.ctx)
    try {
      await cache.fetching
    } finally {
      cache.fetching = null
    }
  }

  async getDescriptor(): Promise<ProviderDescriptor> {
    const initInfo = initCache(this.ctx).info

    // Live model list (with per-model capabilities) from the CLI init response.
    // Empty when CLI is unavailable — no static fallback table (it drifts).
    const models: Model[] = (initInfo?.models ?? []).map((m) => ({
      id: m.value,
      name: m.displayName,
      description: m.description,
      supportedEffortLevels: m.supportedEffortLevels,
      supportsAutoMode: m.supportsAutoMode,
      supportsFastMode: m.supportsFastMode,
      supportsAdaptiveThinking: m.supportsAdaptiveThinking,
    }))

    // Heal a stale selection against the live list. Keep free-form aliases
    // (e.g. fable) when the list is empty so init failures don't wipe choice.
    const knownIds = new Set(models.map((m) => m.id))
    const currentModelId =
      models.length === 0 || knownIds.has(this.currentModelId)
        ? this.currentModelId
        : knownIds.has(DEFAULT_MODEL_ID)
          ? DEFAULT_MODEL_ID
          : models[0]?.id ?? this.currentModelId

    const slashCommands: ProviderDescriptor['slashCommands'] = (() => {
      if (!initInfo?.commands?.length) return CLAUDE_SLASH_COMMANDS

      const seen = new Set<string>()
      const items: NonNullable<ProviderDescriptor['slashCommands']> = []

      for (const cmd of initInfo.commands) {
        if (!cmd.name || seen.has(cmd.name)) continue
        seen.add(cmd.name)
        items.push({ name: cmd.name, description: cmd.description ?? '', type: 'command' })
      }

      return items.length > 0 ? items : CLAUDE_SLASH_COMMANDS
    })()

    const account = initInfo?.account
      ? {
          email: initInfo.account.email,
          organization: initInfo.account.organization,
          subscriptionType: initInfo.account.subscriptionType,
          apiProvider: initInfo.account.apiProvider,
        }
      : undefined

    return {
      id: 'claude-code',
      label: 'Claude Code',
      logo: 'anthropic',
      models,
      modes: CLAUDE_MODES,
      thinkingLevels: CLAUDE_THINKING_LEVELS,
      serviceTiers: CLAUDE_SERVICE_TIERS,
      commands: [],
      slashCommands,
      currentModelId,
      currentModeId: this.currentModeId,
      currentThinkingLevel: this.currentThinkingLevel,
      features: {
        permissions: true,
        attachments: true,
        injection: true,
        sessionResume: true,
        checkpoint: true,
        dynamicSwitch: true,
        contextUsage: true,
        sideChat: true,
      },
      account,
    }
  }

  async createSession(params: RuntimeSessionParams): Promise<RuntimeSession> {
    if (params.modelId) this.currentModelId = normalizeModelId(params.modelId)
    if (params.modeId) this.currentModeId = params.modeId
    if (
      params.thinkingLevel === 'low' ||
      params.thinkingLevel === 'medium' ||
      params.thinkingLevel === 'high' ||
      params.thinkingLevel === 'xhigh' ||
      params.thinkingLevel === 'max'
    ) {
      this.currentThinkingLevel = params.thinkingLevel
    }
    return new ClaudeRuntimeSession(params, this.ctx)
  }
}

/** Claude Code extras that need no session. */
export interface ClaudeCodeNative {
  /** Subscription quota for the signed-in account; null when the CLI cannot answer. */
  accountUsage(options?: { force?: boolean }): Promise<RuntimeUsageLimits | null>
  /** The last quota snapshot (polled or pushed by a session), without polling. */
  peekAccountUsage(): RuntimeUsageLimits | null
  /** The steps of the background sub-agent spawned by `toolUseId` in session `sessionId`. */
  subagentTranscript(sessionId: string, toolUseId: string): Promise<ClaudeSubagentTranscript | null>
}

export type ClaudeCodeEffort = ClaudeThinkingLevel

/** Claude Code, driven through `@anthropic-ai/claude-agent-sdk`. */
export const claudeCode = () =>
  defineProvider<'claude-code', { mode: PermissionMode; effort: ClaudeCodeEffort; native: ClaudeCodeNative }>({
    id: 'claude-code',
    info: ClaudeRuntimeProvider.providerInfo,
    create: (ctx) => new ClaudeRuntimeProvider(ctx),
    native: (ctx) => ({
      accountUsage: (options) => getClaudeAccountUsage(ctx, options),
      peekAccountUsage: () => peekClaudeAccountUsage(ctx),
      subagentTranscript: (sessionId, toolUseId) => readClaudeSubagentTranscript(ctx, sessionId, toolUseId),
    }),
  })
