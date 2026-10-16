import { ProviderManager, tryGetPiModel, type ChatModel, type ProviderType } from 'operon-agents-core'
import type { EffortLevel } from '@operon/agent-runtime'
import { getProviderConfig, type ProviderConfig } from '../provider-config.js'
import { customProviderBaseUrl, type CustomProviderApi } from '../../../../shared/provider-config.js'

// Thinking effort levels operon offers in the picker. Subset of pi's
// ThinkingLevel ("minimal"|"low"|"medium"|"high"|"xhigh") that overlaps operon's
// EffortLevel union — sent straight back as `setThinking(level)`. ("minimal" is
// dropped: not in EffortLevel and rarely useful in the UI.)
export const OPERON_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh']

export interface ModelCapabilities {
  /** Thinking effort levels this model supports (∩ operon's selectable set). */
  effortLevels: EffortLevel[]
  /** Whether the model accepts image input (for attachments gating). */
  vision: boolean
}

/**
 * Map an operon `provider/model` id to a framework `ChatModel`.
 *
 * ProviderManager owns both paths: it keeps known models on pi's built-in registry,
 * while also constructing descriptors for arbitrary configured endpoints/model ids.
 * Keeping API keys and base URLs in the provider config is important in the current
 * framework: authentication is resolved by the provider at request time rather than
 * being embedded in an individual model.
 *
 * The explicit alias supplies conservative metadata only when the model is absent from
 * pi's catalog. Known models retain their catalog descriptor unchanged.
 */

interface ProviderShape {
  /** Framework provider family, which selects the pi API dialect and compatibility. */
  readonly type: ProviderType
  /** Default base URL when the user has not configured one. */
  readonly defaultBaseUrl: string
}

// operon provider id → framework provider family + default endpoint. Everything
// that is not anthropic/google/kimi speaks the OpenAI completions dialect.
const PROVIDER_SHAPES: Record<string, ProviderShape> = {
  anthropic: { type: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com' },
  google: { type: 'google-genai', defaultBaseUrl: 'https://generativelanguage.googleapis.com' },
  openai: { type: 'openai', defaultBaseUrl: 'https://api.openai.com/v1' },
  deepseek: { type: 'openai', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  kimi: { type: 'kimi', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  glm: { type: 'openai', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  minimax: { type: 'openai', defaultBaseUrl: 'https://api.minimax.chat/v1' },
  grok: { type: 'openai', defaultBaseUrl: 'https://api.x.ai/v1' },
  openrouter: { type: 'openai', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  vercel: { type: 'openai', defaultBaseUrl: 'https://ai-gateway.vercel.sh/v1' },
  ollama: { type: 'openai', defaultBaseUrl: 'http://localhost:11434/v1' },
}

/** A user-added provider's wire API → the framework family that speaks it. */
const CUSTOM_PROVIDER_TYPES: Record<CustomProviderApi, ProviderType> = {
  'anthropic-messages': 'anthropic',
  'openai-completions': 'openai',
  'openai-responses': 'openai_responses',
}

// operon provider id → pi KnownProvider for capability lookup. Providers that pi
// does not catalog use the conservative fallback in `getModelCapabilities`.
const PI_PROVIDER_ALIAS: Record<string, string> = {
  anthropic: 'anthropic',
  google: 'google',
  openai: 'openai',
  deepseek: 'deepseek',
  kimi: 'moonshotai',
  glm: 'zai',
  minimax: 'minimax',
  grok: 'xai',
  openrouter: 'openrouter',
  vercel: 'vercel-ai-gateway',
}

function splitModelId(modelId: string): { providerId: string; model: string } {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return { providerId: 'anthropic', model: modelId }
  return { providerId: modelId.slice(0, slash), model: modelId.slice(slash + 1) }
}

/**
 * Per-model capabilities (thinking levels + vision), read from pi's model registry.
 * Known models report their real thinking levels and image support; unknown / custom
 * endpoints fall back to "no thinking" (conservative) but assume vision-capable, matching
 * the fallback alias declared in `resolveModel`.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const { providerId, model } = splitModelId(modelId)
  const piProvider = PI_PROVIDER_ALIAS[providerId]
  if (piProvider) {
    const known = tryGetPiModel(piProvider, model)
    if (known) {
      const levels = known.thinkingLevelMap ? Object.keys(known.thinkingLevelMap) : []
      return {
        effortLevels: OPERON_EFFORT_LEVELS.filter((l) => levels.includes(l)),
        vision: known.input?.includes('image') ?? false,
      }
    }
  }
  return { effortLevels: [], vision: true }
}

/** Multi-vendor gateways whose `vendor/model` ids include Claude: operon provider id → host + pi catalog. */
const GATEWAYS: Record<string, { host: string; piProvider: string }> = {
  openrouter: { host: 'openrouter.ai', piProvider: 'openrouter' },
  vercel: { host: 'ai-gateway.vercel.sh', piProvider: 'vercel-ai-gateway' },
}

function isOnHost(baseUrl: string, host: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname
    return hostname === host || hostname.endsWith(`.${host}`)
  } catch {
    return false
  }
}

/**
 * Claude models on a gateway go through its Anthropic Messages endpoint (OpenRouter `/api`,
 * Vercel's root), where the framework's SearchTool defers MCP tools with native
 * `tool_addition` blocks (Opus 4.8+, Sonnet 5.5, …); the loaded set lives in our own
 * transcript, so it survives every request.
 *
 * Every other model stays on Chat Completions and gets every tool up front. OpenRouter's
 * Responses `openrouter:tool_search` is deliberately NOT used: what a search reveals lasts
 * one HTTP request. After any tool round the model can no longer call a tool it found
 * (measured 2026-09-29: GLM retried a failed `list_issues` 0/6 deferred vs 6/6 loaded) or
 * guesses its arguments (DeepSeek), and replaying the search item, `allowed_tools` and
 * `additional_tools` all leave the next request unchanged. GLM, DeepSeek and Grok have no
 * native mid-conversation tool additions to fall back on.
 *
 * The framework provider key of the Claude path must NOT be pi's catalog id: ProviderManager
 * would then base it on pi's built-in catalog, whose known models keep their catalog dialect
 * whatever `type` says. A fresh key builds the model from `type`, so the catalog's limits and
 * reasoning flag are carried over by hand instead. The same goes the other way for Vercel:
 * pi catalogs every Vercel model on Anthropic Messages, so its Chat Completions path uses the
 * fresh key `vercel` and carries the limits over too.
 */
function isClaude(model: string): boolean {
  return /^anthropic\/claude-/.test(model)
}

interface ResolvedProvider {
  /** Key the provider is registered under in ProviderManager. */
  key: string
  type: ProviderType
  baseUrl: string
  maxContextSize: number
  maxOutputSize: number
  capabilities: string[]
}

type ModelLimits = Pick<ResolvedProvider, 'maxContextSize' | 'maxOutputSize' | 'capabilities'>

function catalogLimits(piProvider: string, model: string, fallback: ModelLimits): ModelLimits {
  const known = tryGetPiModel(piProvider, model)
  if (!known) return fallback
  return {
    maxContextSize: known.contextWindow || fallback.maxContextSize,
    maxOutputSize: known.maxTokens || fallback.maxOutputSize,
    capabilities: [...(known.input?.includes('image') ? ['vision'] : []), ...(known.reasoning ? ['thinking'] : [])],
  }
}

function resolveProvider(providerId: string, model: string, cfg: ProviderConfig): ResolvedProvider {
  const configuredBaseUrl = cfg.baseUrl
  // A user-added endpoint: its own key (nothing in pi's catalogs) and the conservative
  // defaults below. Claude-named models on an Anthropic one still get native tool changes
  // from the framework, which goes by the model id.
  if (cfg.custom) {
    return {
      key: providerId,
      type: CUSTOM_PROVIDER_TYPES[cfg.custom.api],
      baseUrl: configuredBaseUrl ? customProviderBaseUrl(cfg.custom.api, configuredBaseUrl) : '',
      maxContextSize: 200_000,
      maxOutputSize: 16_384,
      capabilities: ['vision'],
    }
  }
  const shape = PROVIDER_SHAPES[providerId] ?? {
    type: 'openai' as const,
    defaultBaseUrl: configuredBaseUrl ?? '',
  }
  const baseUrl = configuredBaseUrl ?? shape.defaultBaseUrl
  const fallback: ResolvedProvider = {
    key: providerId,
    type: shape.type,
    baseUrl,
    maxContextSize: 200_000,
    maxOutputSize: 16_384,
    capabilities: ['vision'],
  }
  const gateway = GATEWAYS[providerId]
  if (!gateway || !isOnHost(baseUrl, gateway.host)) return fallback

  if (isClaude(model)) {
    return {
      ...catalogLimits(gateway.piProvider, model, fallback),
      key: `${providerId}-anthropic`,
      type: 'anthropic',
      baseUrl: baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
    }
  }
  // Registered under pi's own catalog id (OpenRouter), known models already carry their limits.
  if (providerId === gateway.piProvider) return fallback
  return { ...fallback, ...catalogLimits(gateway.piProvider, model, fallback) }
}

export async function resolveModel(modelId: string): Promise<ChatModel> {
  const { providerId, model } = splitModelId(modelId)
  const cfg = getProviderConfig(providerId)
  const provider = resolveProvider(providerId, model, cfg)
  // A self-hosted custom endpoint may take no key; pi's clients still want one to send.
  const apiKey = cfg.apiKey || (cfg.custom ? 'unused' : undefined)
  const manager = new ProviderManager({
    config: {
      providers: {
        [provider.key]: {
          type: provider.type,
          ...(apiKey ? { apiKey } : {}),
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        },
      },
      models: {
        selected: {
          provider: provider.key,
          model,
          maxContextSize: provider.maxContextSize,
          maxOutputSize: provider.maxOutputSize,
          capabilities: provider.capabilities,
        },
      },
    },
  })
  return (await manager.resolveModel('selected')).model
}
