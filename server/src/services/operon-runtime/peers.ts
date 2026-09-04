import { basename } from 'node:path'
import type { Harness, McpServerConfig, PermissionManagerOptions } from 'operon-agents'
import {
  budgetExceeded,
  PEERS_SERVICE,
  type AgentRef,
  type PeerCounters,
  type PeerFleetStats,
  type PeerMemberOptions,
  type PeerNetworkHandle,
  type TeammateSessionOptions,
  type TeammateSpawnRequest,
} from 'operon-agents-peers'
import type { TeamsHostService } from '../../extensions/peers/contract.js'
import { getChatStorage, getSessionManager } from '../ai/state.js'
import { loadPeersConfig, peersConfigSnapshot, type PeersConfig, type TeammateTypeConfig } from './peers-config.js'
import { observeSession } from './passive-observer.js'
import { resolveModel } from './resolve-model.js'
import { MODE_TO_PERMISSION } from './session.js'

/**
 * The host side of the Teams extension.
 *
 * The extension itself is a FILE bundle (`server/src/extensions/peers`, distributed through
 * the Operon extension marketplace) and so shows up in Settings → Extensions like any other.
 * It reaches the app through the `operon-teams` service registered on the harness
 * (`createTeamsHostService`): the teammate types and budget from `peers.json`, how a
 * teammate session is born, and the hook that makes a fresh teammate a real conversation —
 * a chat row in the sidebar the user can open and steer, with its model, permission mode
 * and a transcript observer. Config edits are applied by reloading the extension, which
 * re-runs its `workspace` half against the new config in every open workspace while sessions
 * stay open.
 *
 * The network is a WORKSPACE half: one roster, mailbox and budget per git root, alive while a
 * session there is open. A lead's roster is its workspace's; the Settings view unions every
 * open workspace's.
 */

export interface PeersHostDeps {
  harness: () => Harness | undefined
  /** Workspace `mcp.json` servers + `config.toml` permission policy for a project root. */
  workspaceSetup: (cwd: string) => Promise<{ servers: Record<string, McpServerConfig>; permission: PermissionManagerOptions }>
  /** The model a teammate falls back to when neither its type nor its lead names one. */
  defaultModelId: () => Promise<string>
}

let deps: PeersHostDeps | undefined

export function configurePeersHost(next: PeersHostDeps): void {
  deps = next
}

/** `team:<creatorSessionId>:<name>` → its parts. */
export function parseTeamLabel(label: string): { creatorSessionId: string; name: string } | undefined {
  const parts = label.split(':')
  if (parts.length < 3 || parts[0] !== 'team') return undefined
  return { creatorSessionId: parts[1]!, name: parts.slice(2).join(':') }
}

function withId<T extends object>(meta: T | undefined, id: number): (T & { id: number }) | undefined {
  return meta ? { ...meta, id } : undefined
}

function teammateTitle(cfg: TeammateTypeConfig | undefined, type: string, name: string): string {
  return `${name} · ${cfg?.title ?? type}`
}

/**
 * Standing orders every teammate is born with, whatever its type. The Hub tool tells it HOW
 * to message; this tells it WHEN — without it a teammate answers into its own conversation
 * and the lead, which can only be reached by a `Hub send`, never hears back.
 */
const TEAMMATE_PROTOCOL = [
  'You are a teammate spawned by a team lead. The lead cannot see this conversation.',
  'When your assignment is complete (or you are blocked), you MUST report by calling the Hub tool',
  'with op "send" to "lead", with a concise report: what you did, the result, and paths or ids to look at.',
  'A reply typed into this conversation is not a report. Send exactly one report per assignment; do not wait for an answer afterwards.',
].join('\n')

async function buildTeammateOptions(request: TeammateSpawnRequest): Promise<TeammateSessionOptions> {
  if (!deps) throw new Error('peers host not configured')
  const cfg = peersConfigSnapshot().types[request.type]
  if (!cfg) throw new Error(`Unknown teammate type "${request.type}"`)
  const harness = deps.harness()
  // A root creator's roster id IS its session id (see team-tool.ts), so the creator's
  // workDir — the workspace the team works in — comes straight off its session.
  const creator = harness?.getSession(request.creatorId)
  const workDir = creator?.workDir ?? process.cwd()
  const setup = await deps.workspaceSetup(workDir)
  const mode = MODE_TO_PERMISSION[cfg.modeId ?? 'workspace'] ?? 'workspace'
  return {
    title: teammateTitle(cfg, request.type, request.name),
    workDir,
    mcpServers: setup.servers,
    permission: { ...setup.permission, mode },
    appendSystemPrompt: cfg.instructions ? `${TEAMMATE_PROTOCOL}\n\n${cfg.instructions}` : TEAMMATE_PROTOCOL,
  }
}

/**
 * Right after a teammate session exists and BEFORE its first peer message is routed: pick
 * its model, create the chat row that is its transcript, and start observing its turns.
 */
async function onTeammateCreated(sessionId: string, member: PeerMemberOptions): Promise<void> {
  if (!deps) return
  const harness = deps.harness()
  const session = harness?.getSession(sessionId)
  if (!session) return
  const type = member.type ?? 'member'
  const cfg = peersConfigSnapshot().types[type]
  const storage = getChatStorage()
  const parsed = parseTeamLabel(member.team)
  // The lead is mid-turn right now (it is the turn that spawned us), and a chat's session id
  // only lands on its row when the turn ends — so on a lead's FIRST turn the row lookup misses.
  // The session manager still knows which chat is driving that session.
  const leadRecord = parsed ? getSessionManager().findBySessionId(parsed.creatorSessionId) : undefined
  const leadChat = parsed && storage
    ? (storage.findChatBySessionId(parsed.creatorSessionId)
        ?? (leadRecord ? withId(storage.getChatMeta(leadRecord.chatId), leadRecord.chatId) : undefined))
    : undefined

  const modelId = cfg?.modelId ?? leadChat?.model ?? leadRecord?.params.modelId ?? (await deps.defaultModelId())
  try {
    session.setModel(await resolveModel(modelId))
  } catch (error) {
    console.warn(`[operon.peers] teammate ${member.name}: model ${modelId} unavailable, keeping harness default:`, error instanceof Error ? error.message : String(error))
  }

  if (storage) {
    const result = storage.patchChatEntry(null, {
      baseRevision: 0,
      replaceFrom: 0,
      tailMessages: [],
      tp: 'teammate',
      title: teammateTitle(cfg, type, member.name),
      workspaceId: leadChat?.workspaceId,
      model: modelId,
      providerId: 'custom',
      sessionId,
      updatedAt: Date.now(),
      metadata: {
        peer: {
          name: member.name,
          team: member.team,
          type,
          creatorSessionId: parsed?.creatorSessionId ?? '',
          ...(leadChat ? { leadChatId: leadChat.id } : {}),
        },
      },
    })
    if (!result.success) console.warn(`[operon.peers] could not create chat row for teammate ${member.name}`)
  }
  observeSession(session)
}

/** The `operon-teams` service the Teams extension bundle consumes (see `extensions/peers/contract.ts`). */
export function createTeamsHostService(): TeamsHostService {
  return {
    async config() {
      const config = await loadPeersConfig()
      return {
        budget: config.budget,
        types: Object.fromEntries(
          Object.entries(config.types).map(([id, t]) => [id, { title: t.title, ...(t.description ? { description: t.description } : {}) }]),
        ),
      }
    },
    teammateOptions: buildTeammateOptions,
    onTeammateCreated,
  }
}

/** Apply a config change: re-run the extension's `workspace` half against `peers.json` in every open workspace, if it is loaded. */
export async function reloadPeersExtension(): Promise<void> {
  const manager = deps?.harness()?.extensions
  if (!manager) return
  const status = (await manager.list()).find((s) => s.id === PEERS_SERVICE)
  if (status?.state === 'loaded') await manager.reload(PEERS_SERVICE)
}

/**
 * Disband a team: take every member off the roster (its mailbox settled, its name free
 * again), close their sessions, and drop the team label from its creator. Chat rows stay:
 * the transcripts are history.
 */
export async function disbandTeam(label: string): Promise<{ members: number }> {
  const harness = deps?.harness()
  if (!harness || !harness.services.has(PEERS_SERVICE)) throw new Error('The Teams extension is not loaded')
  if (!parseTeamLabel(label)) throw new Error(`Not a team label: ${label}`)
  // A team lives in its workspace's network: the one whose roster carries the label.
  let net: PeerNetworkHandle | undefined
  for (const candidate of networks()) {
    if ((await candidate.net.list()).some((ref) => ref.labels?.includes(label))) {
      net = candidate.net
      break
    }
  }
  if (!net) throw new Error(`No open workspace holds team ${label}`)
  const { members } = await net.disbandTeam(label)
  for (const ref of members) await harness.closeSession(ref.sessionId).catch(() => undefined)
  return { members: members.length }
}

/** The network of the workspace `workDir` belongs to (a handle; resolves at call time). */
function networkFor(harness: Harness, workDir: string): PeerNetworkHandle | undefined {
  if (!harness.services.has(PEERS_SERVICE)) return undefined
  return harness.workspaceService<PeerNetworkHandle>(PEERS_SERVICE, { workDir })
}

/** Every open workspace's network — what a chat-less, harness-wide view unions over. */
function networks(): Array<{ workDir: string; net: PeerNetworkHandle }> {
  const harness = deps?.harness()
  if (!harness || !harness.services.has(PEERS_SERVICE)) return []
  return harness.openWorkspaces().map((workspace) => ({
    workDir: workspace.workDir,
    net: harness.workspaceService<PeerNetworkHandle>(PEERS_SERVICE, { workspaceKey: workspace.key }),
  }))
}

// ── DTOs ─────────────────────────────────────────────────────────────────────
export interface PeerMemberDTO {
  name: string
  type: string
  typeTitle: string
  description?: string
  status: AgentRef['status']
  sessionId: string
  chatId?: number
  updatedAt: number
  /** Tool approvals parked on this member's session (nobody is live to answer them). */
  pendingApprovals: number
}

export interface PeerTeamDTO {
  label: string
  name: string
  creatorSessionId: string
  leadChatId?: number
  leadStatus?: AgentRef['status']
  members: PeerMemberDTO[]
}

/**
 * One line of the fleet's spend, named.
 *
 * The totals alone are unreadable: they are an accumulation of EVERY model call, so a number
 * far larger than any one conversation's context is normal and correct — and there is no way
 * to tell from the total which part of it a teammate spent. Worse, the framework attributes
 * `usage.updated` to any session that mounted the Teams hub, in or out of a team (see
 * `PeerNetwork.observe`), so a lead's ordinary back-and-forth with the user lands in the same
 * ledger. Splitting the total per agent is what makes that visible instead of suspicious.
 */
export interface PeerAgentStatsDTO extends PeerCounters {
  agentId: string
  /** How the row reads: a teammate's name, the lead's chat title, or the raw id. */
  label: string
  /** `other` = a conversation that mounted the hub but is in no team — spend nobody asked a team for. */
  kind: 'member' | 'lead' | 'other'
}

export interface PeersStatsDTO {
  totals: PeerCounters
  /** The totals, split by who spent it. Descending by `totalTokens`. */
  agents: PeerAgentStatsDTO[]
  budget: PeersConfig['budget']
  /** The reason peer traffic is paused, when the budget is exhausted. */
  exceeded?: string
}

export interface PeersRosterDTO {
  /** The Teams extension is loaded and its network is up. */
  available: boolean
  teams: PeerTeamDTO[]
  stats: PeersStatsDTO | null
  types: Array<{ id: string; title: string; description?: string }>
}

async function toMemberDTO(ref: AgentRef): Promise<PeerMemberDTO> {
  const storage = getChatStorage()
  const cfg = peersConfigSnapshot().types[ref.type]
  const chat = storage?.findChatBySessionId(ref.sessionId)
  const session = deps?.harness()?.getSession(ref.sessionId)
  let pendingApprovals = 0
  if (session) {
    try {
      pendingApprovals = (await session.pendingInterruptions()).length
    } catch {
      pendingApprovals = 0
    }
  }
  return {
    name: ref.name ?? ref.agentId,
    type: ref.type,
    typeTitle: cfg?.title ?? ref.type,
    ...(ref.description ? { description: ref.description } : {}),
    status: ref.status,
    sessionId: ref.sessionId,
    ...(chat ? { chatId: chat.id } : {}),
    updatedAt: ref.updatedAt,
    pendingApprovals,
  }
}

async function groupTeams(refs: readonly AgentRef[], leads: readonly AgentRef[]): Promise<PeerTeamDTO[]> {
  const storage = getChatStorage()
  const byLabel = new Map<string, PeerTeamDTO>()
  const ensure = (label: string): PeerTeamDTO | undefined => {
    const parsed = parseTeamLabel(label)
    if (!parsed) return undefined
    let team = byLabel.get(label)
    if (!team) {
      const leadChat = storage?.findChatBySessionId(parsed.creatorSessionId)
      const lead = leads.find((l) => l.agentId === parsed.creatorSessionId)
      team = {
        label,
        name: parsed.name,
        creatorSessionId: parsed.creatorSessionId,
        ...(leadChat ? { leadChatId: leadChat.id } : {}),
        ...(lead ? { leadStatus: lead.status } : {}),
        members: [],
      }
      byLabel.set(label, team)
    }
    return team
  }
  // A creator with a team label but no members yet still shows as a team.
  for (const lead of leads) for (const label of lead.labels ?? []) ensure(label)
  for (const ref of refs) {
    const member = await toMemberDTO(ref)
    for (const label of ref.labels ?? []) ensure(label)?.members.push(member)
  }
  return [...byLabel.values()]
}

/**
 * Name a spender. A member's roster id is `<team label>/<name>` (`memberAgentId`); every other
 * id is a SESSION id, because that is what a mounted hub reports usage under — either this
 * team's lead or an unrelated conversation, told apart by whether a team claims it as creator.
 */
function labelAgent(agentId: string, teams: PeerTeamDTO[]): { label: string; kind: PeerAgentStatsDTO['kind'] } {
  for (const team of teams) {
    const member = team.members.find((m) => agentId === `${team.label}/${m.name}`)
    if (member) return { label: member.name, kind: 'member' }
    if (agentId === team.creatorSessionId) return { label: chatTitle(agentId) ?? `${team.name} lead`, kind: 'lead' }
  }
  return { label: chatTitle(agentId) ?? agentId.slice(0, 12), kind: 'other' }
}

function chatTitle(sessionId: string): string | undefined {
  return getChatStorage()?.findChatBySessionId(sessionId)?.title?.trim() || undefined
}

function sumCounters(a: PeerCounters, b: PeerCounters): PeerCounters {
  return {
    messagesSent: a.messagesSent + b.messagesSent,
    messagesReceived: a.messagesReceived + b.messagesReceived,
    wakes: a.wakes + b.wakes,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  }
}

const ZERO_COUNTERS: PeerCounters = { messagesSent: 0, messagesReceived: 0, wakes: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }

/**
 * Spend across workspaces, as one table. The budget is PER workspace (each network enforces its
 * own), so `exceeded` names the first workspace that is paused rather than judging the sum.
 */
function statsDTO(fleets: Array<{ workDir?: string; stats: PeerFleetStats }>, config: PeersConfig, teams: PeerTeamDTO[]): PeersStatsDTO {
  const totals = fleets.reduce((acc, { stats }) => sumCounters(acc, stats.totals), ZERO_COUNTERS)
  let exceeded: string | undefined
  for (const { workDir, stats } of fleets) {
    const reason = budgetExceeded(stats, config.budget)
    if (reason) {
      exceeded = workDir !== undefined && fleets.length > 1 ? `${basename(workDir)}: ${reason}` : reason
      break
    }
  }
  const agents = fleets
    .flatMap(({ stats }) => stats.agents)
    // A row that never spent anything is noise — every mounted hub registers one.
    .filter((a) => a.totalTokens > 0)
    .map((a) => ({ ...a, ...labelAgent(a.agentId, teams) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
  return { totals, agents, budget: config.budget, ...(exceeded ? { exceeded } : {}) }
}

function typesDTO(config: PeersConfig): PeersRosterDTO['types'] {
  return Object.entries(config.types).map(([id, t]) => ({ id, title: t.title, ...(t.description ? { description: t.description } : {}) }))
}

/** Teams created by `sessionId` (a lead's chat) — what the Agent panel's Team section shows. */
export async function rosterForSession(sessionId: string): Promise<PeersRosterDTO> {
  const config = await loadPeersConfig()
  const harness = deps?.harness()
  const workDir = harness?.getSession(sessionId)?.workDir
  const net = harness && workDir !== undefined ? networkFor(harness, workDir) : undefined
  if (!net) return { available: false, teams: [], stats: null, types: typesDTO(config) }
  const [members, self, stats] = await Promise.all([net.ownedMembers(sessionId), net.getAgent(sessionId), net.stats()])
  const teams = await groupTeams(members, self ? [self] : [])
  return { available: true, teams, stats: statsDTO([{ workDir, stats }], config, teams), types: typesDTO(config) }
}

/** Every team in every OPEN workspace — the chat-less view for Settings. A workspace with no
 *  session open has no network, so its parked teams show once a chat there opens. */
export async function rosterAll(): Promise<PeersRosterDTO> {
  const config = await loadPeersConfig()
  const harness = deps?.harness()
  if (!harness || !harness.services.has(PEERS_SERVICE)) return { available: false, teams: [], stats: null, types: typesDTO(config) }
  const teams: PeerTeamDTO[] = []
  const fleets: Array<{ workDir: string; stats: PeerFleetStats }> = []
  for (const { workDir, net } of networks()) {
    const [all, stats] = await Promise.all([net.list(), net.stats()])
    const members = all.filter((r) => r.kind === 'session' && r.type !== 'lead' && !isCreatorOnly(r))
    const leads = all.filter((r) => !members.includes(r))
    teams.push(...(await groupTeams(members, leads)))
    fleets.push({ workDir, stats })
  }
  return { available: true, teams, stats: statsDTO(fleets, config, teams), types: typesDTO(config) }
}

/** A creator row: its labels are teams IT made (`team:<self>:…`), never memberships. */
function isCreatorOnly(ref: AgentRef): boolean {
  const labels = ref.labels ?? []
  return labels.length > 0 && labels.every((l) => parseTeamLabel(l)?.creatorSessionId === ref.agentId)
}
