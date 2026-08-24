import type * as acp from '@zed-industries/agent-client-protocol'
import type { Model } from '../../types.js'
import type { AcpDiscoveryContext, AcpModelDiscovery, AcpProviderConfig, AcpUsage } from '../acp/index.js'

export const GROK_DEFAULT_MODEL_ID = 'grok-4.5'

const GROK_FALLBACK_MODELS: Model[] = [
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    description: "SpaceXAI's frontier coding model",
    providerId: 'grok',
    providerLabel: 'Grok',
    providerLogo: 'grok',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read Grok's advertised models from the `initialize` response `_meta.modelState`. */
function extractGrokModels(ctx: AcpDiscoveryContext, preferredModelId?: string): AcpModelDiscovery {
  const initialize = ctx.initialize
  const modelState = isRecord(initialize?._meta) ? initialize._meta.modelState : undefined
  const available = isRecord(modelState) && Array.isArray(modelState.availableModels)
    ? modelState.availableModels
    : []

  const models: Model[] = available
    .map((entry): Model | null => {
      if (!isRecord(entry) || typeof entry.modelId !== 'string') return null
      // Grok advertises the window per model on the entry's own `_meta`
      // (grok-4.5 = 500K, grok-composer-2.5-fast = 200K).
      const entryMeta = isRecord(entry._meta) ? entry._meta : undefined
      const contextWindow = num(entryMeta?.totalContextTokens)
      return {
        id: entry.modelId,
        name: typeof entry.name === 'string' ? entry.name : entry.modelId,
        description: typeof entry.description === 'string' ? entry.description : undefined,
        providerId: 'grok',
        providerLabel: 'Grok',
        providerLogo: 'grok',
        ...(contextWindow > 0 ? { contextWindow } : {}),
      }
    })
    .filter((model): model is Model => model !== null)

  const resolved = models.length > 0 ? models : GROK_FALLBACK_MODELS
  const availableIds = new Set(resolved.map((m) => m.id))
  const advertisedCurrent = isRecord(modelState) && typeof modelState.currentModelId === 'string'
    ? modelState.currentModelId
    : undefined

  const currentModelId =
    preferredModelId && availableIds.has(preferredModelId)
      ? preferredModelId
      : advertisedCurrent && availableIds.has(advertisedCurrent)
        ? advertisedCurrent
        : resolved[0].id

  return { models: resolved, currentModelId }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** JSON round-trip so the raw `_meta` is a plain JSONObject for `usage.raw`. */
function toJsonRecord(value: unknown): AcpUsage['raw'] {
  try {
    return JSON.parse(JSON.stringify(value ?? {})) as AcpUsage['raw']
  } catch {
    return undefined
  }
}

/**
 * Grok reports a full per-turn breakdown on the prompt response's
 * `_meta.usage` (and mirrors the top-line counters flat on `_meta`). Map it onto
 * the AI-SDK usage shape; returns undefined when neither form is present.
 */
function parseGrokUsage(meta: Record<string, unknown> | undefined): AcpUsage | undefined {
  if (!isRecord(meta)) return undefined
  const usage = isRecord(meta.usage) ? meta.usage : meta
  const hasCounts =
    typeof usage.totalTokens === 'number' ||
    typeof usage.inputTokens === 'number' ||
    typeof usage.outputTokens === 'number'
  if (!hasCounts) return undefined

  const inputTokens = num(usage.inputTokens)
  const outputTokens = num(usage.outputTokens)
  const cachedInputTokens = num(usage.cachedReadTokens)
  const reasoningTokens = num(usage.reasoningTokens)
  const totalTokens = num(usage.totalTokens) || inputTokens + outputTokens

  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: Math.max(inputTokens - cachedInputTokens, 0),
      cacheReadTokens: cachedInputTokens,
      cacheWriteTokens: 0,
    },
    outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens },
    totalTokens,
    raw: toJsonRecord(meta),
    reasoningTokens,
    cachedInputTokens,
  }
}

/**
 * Grok stamps the session's *current* context size on every `session/update`
 * `_meta.totalTokens`. Unlike the turn's `usage.inputTokens` (summed over the
 * turn's model calls) this is a gauge: it tracks the live prompt size and can
 * dip as the prompt is re-assembled. It is the only Grok number that means
 * "how full is the context".
 */
function parseGrokContextTokens(meta: Record<string, unknown> | undefined): number | undefined {
  if (!isRecord(meta)) return undefined
  const totalTokens = meta.totalTokens
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) {
    return undefined
  }
  return totalTokens
}

/**
 * Grok reports skills and builtin commands through the same
 * `available_commands_update` list; only the skills carry `_meta.path` (the
 * SKILL.md they were loaded from) and `_meta.scope` ('user' | 'bundled').
 * It picks skills up from every agent's convention — `~/.grok/skills`,
 * `~/.agents/skills`, `~/.claude/skills`, `~/.claude/commands`, and plugin
 * caches — so this list is not Grok-authored content only.
 */
function classifyGrokCommand(command: acp.AvailableCommand): 'skill' | 'command' | undefined {
  const meta = isRecord(command._meta) ? command._meta : undefined
  return typeof meta?.path === 'string' && meta.path.trim() ? 'skill' : 'command'
}

export const GROK_CONFIG: AcpProviderConfig = {
  providerId: 'grok',
  cliId: 'grok',
  label: 'Grok',
  logo: 'grok',
  agentArgs: ['agent', 'stdio'],
  modes: [
    { id: 'default', name: 'Default', description: 'Ask before edits and commands' },
    { id: 'plan', name: 'Plan', description: 'Read-only planning; no tool execution' },
    { id: 'auto', name: 'Auto', description: 'Auto-approve safe operations' },
    { id: 'bypassPermissions', name: 'Full Access', description: 'Auto-approve everything' },
  ],
  defaultModeId: 'default',
  defaultModelId: GROK_DEFAULT_MODEL_ID,
  features: {
    permissions: true,
    attachments: false,
    injection: false,
    sessionResume: true,
  },
  modelProbe: 'initialize',
  // Worth the extra newSession (~1.3s): it puts Grok's 46 commands — 32 of them
  // skills — in the `/` menu before the first message instead of after it.
  probeCommands: true,
  extractModels: extractGrokModels,
  parseUsage: parseGrokUsage,
  parseContextTokens: parseGrokContextTokens,
  classifyCommand: classifyGrokCommand,
}
