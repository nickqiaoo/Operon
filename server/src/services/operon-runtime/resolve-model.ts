import { piCatalog } from '../pi-catalog.js'
import { createModelManager, type ChatModel } from 'operon-agents'
import type { DecisionModel, ModelProviderRegistration } from 'operon-agents/advanced'
import type { EffortLevel } from '@operon/agent-runtime'
import { getProviderConfig, getProviderConfigs, isProviderUsable, type ProviderConfig } from '../provider-config.js'
import { customProviderBaseUrl } from '../../../../shared/provider-config.js'

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
 * The one model manager of this process; the harness runs on it.
 *
 * The framework owns the wire details. A provider without `api` comes from pi's catalog,
 * a provider with one is a custom endpoint; this file only registers which applies and which
 * key and address the user set.
 */
export const modelManager = createModelManager()

function splitModelId(modelId: string): { providerId: string; model: string } {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return { providerId: 'anthropic', model: modelId }
  return { providerId: modelId.slice(0, slash), model: modelId.slice(slash + 1) }
}

/**
 * Per-model capabilities (thinking levels + vision), read from pi's model registry.
 * Known models report their real thinking levels and image support; unknown / custom
 * endpoints fall back to "no thinking" (conservative) but assume vision-capable, matching
 * `UNLISTED_MODEL_LIMITS`.
 */
export function getModelCapabilities(modelId: string): ModelCapabilities {
  const { providerId, model } = splitModelId(modelId)
  const known = modelManager.models.getModel(providerId, model)
  if (known) {
    // A `null` level is one the model does not support; pi would clamp it to another.
    const levels = Object.entries(known.thinkingLevelMap ?? {})
      .filter(([, value]) => value !== null)
      .map(([level]) => level)
    return {
      effortLevels: OPERON_EFFORT_LEVELS.filter((l) => levels.includes(l)),
      vision: known.input?.includes('image') ?? false,
    }
  }
  return { effortLevels: [], vision: true }
}

/** Only for models a provider doesn't list; catalogued models keep their own limits. */
const UNLISTED_MODEL_LIMITS = { contextWindow: 200_000, maxTokens: 16_384, input: ['text', 'image'] } as const

/** What the framework needs to know about one provider, or undefined when it can't be reached yet. */
function registrationFor(providerId: string, cfg: ProviderConfig): ModelProviderRegistration | undefined {
  const common = {
    id: providerId,
    allowUnlisted: true,
    ...UNLISTED_MODEL_LIMITS,
    input: [...UNLISTED_MODEL_LIMITS.input],
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
  }
  // A user-added endpoint: nothing in pi's catalogs applies to it.
  if (cfg.custom) {
    return cfg.baseUrl
      ? { ...common, api: cfg.custom.api, baseUrl: customProviderBaseUrl(cfg.custom.api, cfg.baseUrl) }
      : undefined
  }
  if (!piCatalog.getProvider(providerId)) return undefined
  return { ...common, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) }
}

/** Bring one provider in the manager in line with its saved config. */
export function syncModelProvider(providerId: string): void {
  const registration = registrationFor(providerId, getProviderConfig(providerId))
  if (registration) modelManager.register(registration)
  else modelManager.unregister(providerId)
}

/** Register every provider operon knows of and every one the user has configured. */
export function syncModelProviders(): void {
  for (const providerId of new Set([...piCatalog.getProviders().map((provider) => provider.id), ...Object.keys(getProviderConfigs())])) {
    syncModelProvider(providerId)
  }
}

/** The full `provider/model` form of an id; a bare model id is Anthropic's. */
export function modelRef(modelId: string): string {
  const { providerId, model } = splitModelId(modelId)
  return `${providerId}/${model}`
}

/** The chat model an id names. Throws when it names nothing. */
export function resolveModel(modelId: string): ChatModel {
  return modelManager.resolve(modelRef(modelId))
}

/**
 * The framework catalog holding a provider's decision models. They live under pi's provider id,
 * and only on the provider's own service: a custom base URL is somewhere else, and its key must
 * not be sent to the catalog's endpoints.
 */
function decisionCatalog(providerId: string, cfg: ProviderConfig): string | undefined {
  return cfg.custom || cfg.baseUrl ? undefined : providerId
}

export interface DecisionModelOption {
  modelId: string
  name: string
}

/**
 * Decision models the enabled providers can run, as `provider/model` ids. Read from the catalog
 * rather than each provider's live list, because the framework can only call what it catalogs.
 * An id catalogued as both kinds counts as an LLM there, so it isn't offered as a decision model.
 */
export function listDecisionModels(): DecisionModelOption[] {
  const { models } = modelManager
  return Object.entries(getProviderConfigs()).flatMap(([providerId, cfg]) => {
    const catalog = decisionCatalog(providerId, cfg)
    if (!catalog || !cfg.enabled || !isProviderUsable(providerId, cfg)) return []
    return models
      .getModelsOfType('classifier', catalog)
      .filter((model) => models.getModel(catalog, model.id) === undefined)
      .map((model) => ({ modelId: `${providerId}/${model.id}`, name: model.name }))
  })
}

let lastReviewModel: { key: string; model: ChatModel | DecisionModel } | undefined

/**
 * The model an Auto review pick names, whichever kind it is. Called on every tool call, so the
 * same object comes back until the pick or its provider's config (a rotated key, say) changes.
 */
export async function resolveReviewModel(modelId: string): Promise<ChatModel | DecisionModel> {
  const key = JSON.stringify([modelId, getProviderConfig(splitModelId(modelId).providerId)])
  if (lastReviewModel?.key === key) return lastReviewModel.model
  const model = modelManager.resolveDecision(modelRef(modelId)) ?? resolveModel(modelId)
  lastReviewModel = { key, model }
  return model
}
