import { ProviderManager, tryGetPiModel, type ChatModel, type ProviderType } from 'operon-agents-core'
import type { EffortLevel } from '@operon/agent-runtime'
import { getProviderConfig } from '../provider-config.js'

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
  ollama: { type: 'openai', defaultBaseUrl: 'http://localhost:11434/v1' },
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

export async function resolveModel(modelId: string): Promise<ChatModel> {
  const { providerId, model } = splitModelId(modelId)
  const cfg = getProviderConfig(providerId)
  const shape = PROVIDER_SHAPES[providerId] ?? {
    type: 'openai' as const,
    defaultBaseUrl: cfg.baseUrl ?? '',
  }
  const baseUrl = cfg.baseUrl ?? shape.defaultBaseUrl
  const manager = new ProviderManager({
    config: {
      providers: {
        [providerId]: {
          type: shape.type,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        },
      },
      models: {
        selected: {
          provider: providerId,
          model,
          maxContextSize: 200_000,
          maxOutputSize: 16_384,
          capabilities: ['vision'],
        },
      },
    },
  })
  return (await manager.resolveModel('selected')).model
}
