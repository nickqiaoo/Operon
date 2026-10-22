/**
 * Who plays each role in a spec run, by default.
 *
 * The rule that matters is model diversity: candidates come from different
 * families, and the judge from a family other than the lead's. Two models from
 * different families raising the same point is real signal; the same model
 * agreeing with itself is not. Providers are mapped to families because several
 * of them can run more than one vendor's models (cursor, opencode, copilot,
 * custom) — those count as their own family, which is the honest reading when
 * we cannot see what they will route to.
 */

import type { SpecRoleSettings, SpecRunConfig, SpecSeat } from '../../types/spec.js'

const FAMILY: Record<string, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  grok: 'xai',
  kimi: 'moonshot',
  antigravity: 'google',
}

export function familyOf(providerId: string): string {
  return FAMILY[providerId] ?? providerId
}

/** Candidate preference: one strong design model per family, best known first. */
const CANDIDATE_ORDER = ['claude-code', 'codex', 'grok', 'kimi', 'antigravity', 'cursor', 'opencode', 'copilot', 'custom']
/** Judge preference: whoever is not already in the room, fast and different. */
const JUDGE_ORDER = ['grok', 'kimi', 'antigravity', 'codex', 'claude-code', 'cursor', 'opencode', 'copilot', 'custom']
/** Explorers read a lot and decide little: prefer a fast agent. */
const EXPLORER_ORDER = ['grok', 'codex', 'claude-code', 'kimi', 'cursor', 'opencode', 'custom']

export interface SpecConfigInput {
  /** Providers that are installed and usable here. */
  available: readonly string[]
  /** The launching chat's provider and model — the lead runs there. */
  lead: SpecSeat
  /**
   * Providers the user named, if any. Naming agents is also a limit: every seat
   * (judge, builder, explorers too) is then filled from these plus the lead —
   * people name agents precisely when others are off the table (quota, cost).
   * An entry may name the model too, `provider:model` (e.g.
   * `opencode:opencode/deepseek-v4.1-flash-free`): every seat of that provider
   * then runs on it — usually picked for the same reasons, cost and quota.
   */
  candidates?: readonly string[]
  /**
   * Settings → OperonSpec: the seats the user fixed for each role. They win over
   * the automatic picks (and over the limit naming agents sets), except that
   * candidates named in the chat win over the configured ones. A seat whose
   * provider is not usable here is ignored.
   */
  roles?: SpecRoleSettings
}

/** `codex` → `{ providerId: 'codex' }`; `opencode:vendor/model` → with that model (split at the first colon). */
export function parseNamedAgent(entry: string): SpecSeat {
  const i = entry.indexOf(':')
  if (i <= 0 || i === entry.length - 1) return { providerId: entry.trim() }
  return { providerId: entry.slice(0, i).trim(), modelId: entry.slice(i + 1).trim() }
}

function seat(providerId: string, lead: SpecSeat, models: ReadonlyMap<string, string> = new Map()): SpecSeat {
  // A model the user named for this provider wins; otherwise only the lead's own
  // provider inherits its model — for any other provider the chat's model id
  // means nothing, so it runs on that provider's default.
  const named = models.get(providerId)
  if (named) return { providerId, modelId: named }
  return providerId === lead.providerId && lead.modelId ? { providerId, modelId: lead.modelId } : { providerId }
}

/**
 * Pick the default seats. Throws when fewer than two candidate seats can be
 * filled — a single candidate is not a design comparison, and the user should
 * know that before anything runs.
 */
export function defaultSpecConfig(input: SpecConfigInput): SpecRunConfig {
  const available = new Set(input.available)
  const lead = input.lead
  if (!available.has(lead.providerId)) available.add(lead.providerId)

  const named = (input.candidates ?? []).map(parseNamedAgent).filter((s) => available.has(s.providerId))
  const models = new Map(named.flatMap((s) => (s.modelId ? [[s.providerId, s.modelId] as const] : [])))
  const requested = [...new Set(named.map((s) => s.providerId))]
  // The user's picks are taken as given; with none, defaults fill two seats.
  const target = Math.max(requested.length, 2)
  const candidateIds: string[] = []
  const usedFamilies = new Set<string>()
  for (const id of [...requested, ...CANDIDATE_ORDER]) {
    if (!available.has(id) || candidateIds.includes(id)) continue
    // Requested providers are taken as given; defaults keep one per family.
    if (!requested.includes(id) && (requested.length > 0 || usedFamilies.has(familyOf(id)))) continue
    candidateIds.push(id)
    usedFamilies.add(familyOf(id))
    if (candidateIds.length === target) break
  }
  // Naming agents is also a limit (see `candidates` above): one named agent runs
  // both candidates, each sent in a different direction, rather than bringing in
  // an agent the user left out.
  for (let i = 0; requested.length > 0 && candidateIds.length < 2; i++) {
    candidateIds.push(requested[i % requested.length])
  }
  if (candidateIds.length < 2) {
    throw new Error(
      `A spec needs at least two design candidates from different agents, but only ${candidateIds.length} ` +
        `usable agent(s) are available here (${[...available].join(', ') || 'none'}). Install or configure another agent first.`,
    )
  }

  // With named agents, the other seats come from the named set (plus the lead),
  // in the order the user gave them; otherwise from everything usable here.
  const pool = requested.length > 0 ? new Set([...requested, lead.providerId]) : available
  const pick = (order: string[], avoidFamilies: Set<string>): string => {
    const ranked = requested.length > 0 ? [...requested, lead.providerId, ...order] : order
    return (
      ranked.find((id) => pool.has(id) && !avoidFamilies.has(familyOf(id))) ??
      ranked.find((id) => pool.has(id)) ??
      lead.providerId
    )
  }

  const judgeId = pick(JUDGE_ORDER, new Set([familyOf(lead.providerId)]))
  const builderId = pick(CANDIDATE_ORDER, new Set([familyOf(lead.providerId)]))
  const explorerId = pick(EXPLORER_ORDER, new Set())

  const auto: SpecRunConfig = {
    lead,
    explorer: seat(explorerId, lead, models),
    candidates: candidateIds.map((id) => seat(id, lead, models)),
    judge: seat(judgeId, lead, models),
    builder: seat(builderId, lead, models),
  }
  return applyRoleSettings(auto, input.roles, available, requested.length > 0)
}

/**
 * Lay the user's configured seats over the automatic ones. Pure, for tests.
 * `namedCandidates`: the chat named agents, which win for the candidates.
 */
export function applyRoleSettings(
  config: SpecRunConfig,
  roles: SpecRoleSettings | undefined,
  available: ReadonlySet<string>,
  namedCandidates: boolean,
): SpecRunConfig {
  if (!roles) return config
  const usable = (s: SpecSeat | null | undefined): SpecSeat | null =>
    s?.providerId && available.has(s.providerId) ? { providerId: s.providerId, ...(s.modelId ? { modelId: s.modelId } : {}) } : null
  const out: SpecRunConfig = { ...config }
  out.lead = usable(roles.lead) ?? out.lead
  out.explorer = usable(roles.explorer) ?? out.explorer
  out.judge = usable(roles.judge) ?? out.judge
  out.builder = usable(roles.builder) ?? out.builder
  const candidates = (roles.candidates ?? []).map(usable).filter((s): s is SpecSeat => s != null)
  // One configured candidate still needs a second to compare against: keep an automatic one beside it.
  if (!namedCandidates && candidates.length > 0) {
    const extra = config.candidates.find((c) => c.providerId !== candidates[0].providerId)
    out.candidates = candidates.length >= 2 ? candidates : [candidates[0], extra ?? { ...candidates[0] }]
  }
  const implementer = usable(roles.implementer)
  if (implementer) out.implementer = implementer
  const reviewer = usable(roles.reviewer)
  if (reviewer) out.reviewer = reviewer
  const coordinator = usable(roles.coordinator)
  if (coordinator) out.coordinator = coordinator
  return out
}

/** Candidate keys in order: A, B, C… */
export function candidateKey(index: number): string {
  return String.fromCharCode(65 + index)
}

/** The providers a spec already works with — the build stage stays inside them, as naming agents is a limit. */
export function specPool(config: SpecRunConfig): string[] {
  return [...new Set(allSeats(config).map((s) => s.providerId))]
}

/** Every seat the config names, the build seats first. */
function allSeats(config: SpecRunConfig): SpecSeat[] {
  const build = [config.implementer, config.reviewer, config.coordinator].filter((s): s is SpecSeat => s != null)
  return [...build, config.lead, ...config.candidates, config.judge, config.builder, config.explorer]
}

/** The seat that coordinates the build: its own, or the lead's. */
export function coordinatorSeat(config: SpecRunConfig): SpecSeat {
  return config.coordinator ?? config.lead
}

/** Builders preferred by default: the doc's default (codex) first, then the strongest coders. */
const IMPLEMENTER_ORDER = ['codex', 'claude-code', 'cursor', 'grok', 'kimi', 'opencode', 'antigravity', 'copilot', 'custom']

export const DEFAULT_CONCURRENCY = 3

/** The build-stage seats, filled in for specs whose config predates them. */
export function withBuildDefaults(config: SpecRunConfig): Required<Pick<SpecRunConfig, 'implementer' | 'concurrency'>> & SpecRunConfig {
  const pool = specPool(config)
  const implementer =
    config.implementer ?? seatFor(config, IMPLEMENTER_ORDER.find((id) => pool.includes(id)) ?? config.lead.providerId)
  return { ...config, implementer, concurrency: config.concurrency ?? DEFAULT_CONCURRENCY }
}

/**
 * The seat a build-stage role on `providerId` takes — an implementer, a ticket
 * reviewer, a whole-change reviewer. Those seats are chosen as providers, so they
 * run on whatever model the spec already uses that provider with (one the user
 * named, or the lead's own); only a provider the spec never gave a model runs on
 * its default. Without this they all ran on the provider's default, whatever
 * model the user had started the spec with.
 */
export function seatFor(config: SpecRunConfig, providerId: string): SpecSeat {
  const withModel = allSeats(config).find((s) => s.providerId === providerId && s.modelId)
  return withModel ? { providerId, modelId: withModel.modelId } : { providerId }
}

/**
 * Who reviews a ticket built by `implementer`: someone from another family, out
 * of the providers this spec already uses. Two families agreeing a diff is good
 * is the point; one reviewing itself is a formality. Falls back to another
 * provider of the same family, then to the implementer itself, only when the
 * spec has nobody else. A reviewer seat the user set (settings, or a switch)
 * wins over all of that.
 */
export function reviewerFor(config: SpecRunConfig, implementer: string): string {
  // A reviewer the user picked reviews every ticket, whatever family built it.
  if (config.reviewer) return config.reviewer.providerId
  const pool = specPool(config)
  const preferred = [config.judge.providerId, config.builder.providerId, ...pool]
  return (
    preferred.find((id) => familyOf(id) !== familyOf(implementer)) ??
    preferred.find((id) => id !== implementer) ??
    implementer
  )
}
