import { getProviderModels } from '../ai/providers.js'
import { warmAllProviders } from '../ai/provider-models-cache.js'

const toProviderId = (id: string) => id === 'operon' ? 'custom' : id

/**
 * How many models are listed outright.
 *
 * Above this the entry degrades to a summary instead. Sized from the real
 * spread: CLI agents report 1–17 models each (the whole install is ~2KB), so
 * they always list in full and nothing changes for them. The one that can be
 * enormous is `operon`, whose models are not a CLI's fixed set but every model
 * of every LLM provider the user has an API key for — an OpenRouter key alone is
 * several hundred.
 */
const INLINE_MODEL_LIMIT = 25
/** Vendor groups offered when a list is too long to show. */
const MAX_GROUPS = 20
/** Ids shown alongside the groups, purely to make the shape concrete. */
const SAMPLE_SIZE = 5

export interface AgentModelCatalogEntry {
  agentType: string
  /** What this agent runs when a script passes `model: 'default'`. Never filtered out. */
  currentModel?: string
  /** The choosable list — present only when short enough to choose from directly. */
  models?: Array<{ id: string; name?: string }>
  /** Total matching this lookup. Present only when `models` was withheld. */
  totalModels?: number
  /** Vendor prefixes with counts — the menu to put in front of the user. */
  groups?: Array<{ prefix: string; count: number }>
  /** Set only when `groups` was cut: how many families there actually are. */
  totalGroups?: number
  sample?: string[]
  hint?: string
  /** The provider could not be reached even after waiting for its probe. */
  pending?: boolean
  error?: string
}

/**
 * Group ids by everything before the last `/`.
 *
 * Derived from the data rather than from a hand-kept vendor table: an operon id
 * is `<llm-provider>/<vendor>/<model>` (`openrouter/anthropic/claude-…`), so this
 * yields exactly the axis a person chooses along. Ids with no slash (`gpt-5.6-sol`)
 * have no meaningful group, and those lists are short anyway.
 */
function groupByPrefix(ids: readonly string[]): {
  groups: Array<{ prefix: string; count: number }>
  total: number
} {
  const counts = new Map<string, number>()
  for (const id of ids) {
    const cut = id.lastIndexOf('/')
    if (cut <= 0) continue
    const prefix = id.slice(0, cut)
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }
  const sorted = [...counts.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix))
  // Biggest families first, so the cut only ever drops long-tail vendors — and
  // it says how many it dropped, because `query` still searches all of them.
  return { groups: sorted.slice(0, MAX_GROUPS), total: sorted.length }
}

function matches(model: { modelId: string; name?: string }, query: string): boolean {
  const needle = query.toLowerCase()
  return (
    model.modelId.toLowerCase().includes(needle) ||
    (model.name ?? '').toLowerCase().includes(needle)
  )
}

/**
 * One agent's entry, listed in full or summarised.
 *
 * Truncating to "the first N of 300" would be worse than either: the order is
 * arbitrary, so the model the user wants is probably not in the window, and a
 * short list reads as a complete one. A summary says plainly that there are more
 * and gives the caller something specific to ask about.
 */
function toEntry(
  agentType: string,
  result: Awaited<ReturnType<typeof getProviderModels>>,
  query?: string,
  toolName = 'ListAgentModels',
): AgentModelCatalogEntry {
  const currentModel = result.currentModelId || undefined
  const matching = query ? result.models.filter((model) => matches(model, query)) : result.models
  const base = {
    agentType,
    currentModel,
    ...(result.modelsPending ? { pending: true } : {}),
  }

  if (matching.length <= INLINE_MODEL_LIMIT) {
    return {
      ...base,
      models: matching.map((model) => ({ id: model.modelId, name: model.name })),
      ...(query && matching.length === 0
        ? { hint: `No model matches "${query}" for ${agentType}. Call again with a different query, or omit it.` }
        : {}),
    }
  }

  const { groups, total: totalGroups } = groupByPrefix(matching.map((model) => model.modelId))

  // Groups are only an answer if they actually split the list. One group (or
  // none) means every match shares a prefix — offering "openrouter/anthropic
  // (64), pick one" is a dead end, since the thing the user just narrowed by is
  // the only option. Show a window instead and say what it is a window onto.
  if (groups.length < 2) {
    return {
      ...base,
      models: matching.slice(0, INLINE_MODEL_LIMIT).map((model) => ({ id: model.modelId, name: model.name })),
      totalModels: matching.length,
      hint:
        `Showing ${INLINE_MODEL_LIMIT} of ${matching.length}${query ? ` matching "${query}"` : ''}. ` +
        'Narrow the query further, or let the user pick from these.',
    }
  }

  return {
    ...base,
    totalModels: matching.length,
    groups,
    ...(totalGroups > groups.length ? { totalGroups } : {}),
    // The first entries are the user's hand-entered model ids (`manualModels` is
    // pushed before anything fetched), which makes this sample the most likely
    // to be the ones they actually use.
    sample: matching.slice(0, SAMPLE_SIZE).map((model) => model.modelId),
    hint:
      `${matching.length} models — too many to choose from. Ask the user which family they want ` +
      `(offer the groups above${totalGroups > groups.length ? `, ${totalGroups} in total` : ''}), then call ` +
      `${toolName} again with query:"<their answer>" — it searches every model, not just the listed families. ` +
      `model:'default' uses ${currentModel ?? 'this agent’s own model'} without choosing.`,
  }
}

/**
 * Read each agent's model list from the provider cache.
 *
 * The cache is SWR: a warm read is instant, and a provider that is still probing
 * its CLI returns `modelsPending` with an EMPTY list rather than waiting. That is
 * right for a UI that re-renders, and wrong here — this catalog is read once, to
 * put in front of a user, and "copilot: no models" would read as "that agent has
 * nothing to offer" when it simply had not finished starting. So pending entries
 * are given one wait (`warmAllProviders` awaits the refresh) and re-read.
 *
 * One failing provider yields an entry with `error` rather than failing the whole
 * lookup: the user can still choose for the agents that did answer.
 */
export async function agentModelCatalog(
  availableAgents: readonly string[],
  query?: string,
  toolName = 'ListAgentModels',
): Promise<AgentModelCatalogEntry[]> {
  const read = async (agentType: string): Promise<AgentModelCatalogEntry> => {
    try {
      return toEntry(agentType, await getProviderModels(toProviderId(agentType)), query, toolName)
    } catch (error) {
      return {
        agentType,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const first = await Promise.all(availableAgents.map(read))
  const stillProbing = first.filter((entry) => entry.pending).map((entry) => entry.agentType)
  if (stillProbing.length === 0) return first

  await warmAllProviders(stillProbing.map(toProviderId))
  const settled = new Map(await Promise.all(stillProbing.map(async (a) => [a, await read(a)] as const)))
  return first.map((entry) => settled.get(entry.agentType) ?? entry)
}

