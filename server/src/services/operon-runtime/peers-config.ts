import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PEERS_CONFIG_PATH } from './paths.js'

/**
 * Teams settings — what the marketplace-installed Teams extension is configured with. Edited from
 * Settings → Extensions → Teams and applied by reloading the extension (its `create` reads
 * this through the `operon-teams` service). On/off is not here: that is loading / unloading
 * the extension itself, like any other.
 *
 * The teammate types are the parameter boundary of `Team spawn`: the HOST says what a
 * `coder` is (title, description, model, permission mode, extra instructions); the model
 * only ever picks a type and a name.
 */
export interface TeammateTypeConfig {
  /** Short display title, also the session title prefix. */
  title: string
  /** One line shown on the roster so a lead knows who to ask. */
  description?: string
  /** Model id (`provider/model`). Absent → the lead's current model. */
  modelId?: string
  /** operon permission mode id: manual / workspace / auto / yolo. Absent → workspace. */
  modeId?: string
  /** Appended to the teammate's system prompt. */
  instructions?: string
}

export interface PeersConfig {
  budget: {
    /** Fleet-wide cap on peer-triggered wakes; absent = unlimited. */
    maxWakes?: number
    /** Fleet-wide cap on tokens spent by peer sessions; absent = unlimited. */
    maxTotalTokens?: number
  }
  types: Record<string, TeammateTypeConfig>
}

export const DEFAULT_TEAMMATE_TYPES: Record<string, TeammateTypeConfig> = {
  coder: {
    title: 'Coder',
    description: 'Implements a well-scoped change end to end: code, tests, and a short report back.',
    modeId: 'workspace',
  },
  reviewer: {
    title: 'Reviewer',
    description: 'Reviews a change for correctness and risk; reads and runs, never edits.',
    modeId: 'workspace',
    instructions: 'You are a code reviewer. Do not modify files — read, run checks, and report findings with file:line references.',
  },
  researcher: {
    title: 'Researcher',
    description: 'Investigates a question in the codebase or on the web and reports what it found.',
    modeId: 'workspace',
    instructions: 'You are a researcher. Gather facts, cite file paths or URLs, and keep the report concise. Do not change code.',
  },
}

export const DEFAULT_PEERS_CONFIG: PeersConfig = {
  budget: { maxWakes: 200, maxTotalTokens: 5_000_000 },
  types: DEFAULT_TEAMMATE_TYPES,
}

const TYPE_ID = /^[a-z][a-z0-9_-]{0,31}$/

let cached: PeersConfig | undefined

function normalize(raw: unknown): PeersConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const budgetRaw = (r.budget && typeof r.budget === 'object' ? r.budget : {}) as Record<string, unknown>
  const typesRaw = (r.types && typeof r.types === 'object' ? r.types : DEFAULT_TEAMMATE_TYPES) as Record<string, unknown>
  const types: Record<string, TeammateTypeConfig> = {}
  for (const [id, value] of Object.entries(typesRaw)) {
    if (!TYPE_ID.test(id) || !value || typeof value !== 'object') continue
    const t = value as Record<string, unknown>
    const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : id
    types[id] = {
      title,
      ...(typeof t.description === 'string' && t.description.trim() ? { description: t.description.trim() } : {}),
      ...(typeof t.modelId === 'string' && t.modelId.trim() ? { modelId: t.modelId.trim() } : {}),
      ...(typeof t.modeId === 'string' && t.modeId.trim() ? { modeId: t.modeId.trim() } : {}),
      ...(typeof t.instructions === 'string' && t.instructions.trim() ? { instructions: t.instructions.trim() } : {}),
    }
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
  return {
    budget: {
      ...(num(budgetRaw.maxWakes) !== undefined ? { maxWakes: num(budgetRaw.maxWakes) } : {}),
      ...(num(budgetRaw.maxTotalTokens) !== undefined ? { maxTotalTokens: num(budgetRaw.maxTotalTokens) } : {}),
    },
    types,
  }
}

export async function loadPeersConfig(): Promise<PeersConfig> {
  if (cached) return cached
  try {
    const text = await readFile(PEERS_CONFIG_PATH, 'utf8')
    cached = normalize(JSON.parse(text))
  } catch {
    cached = DEFAULT_PEERS_CONFIG
  }
  return cached
}

/** Synchronous read of the last loaded value (defaults before the first load). */
export function peersConfigSnapshot(): PeersConfig {
  return cached ?? DEFAULT_PEERS_CONFIG
}

export async function savePeersConfig(next: unknown): Promise<PeersConfig> {
  const config = normalize(next)
  await mkdir(path.dirname(PEERS_CONFIG_PATH), { recursive: true })
  await writeFile(PEERS_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
  cached = config
  return config
}
