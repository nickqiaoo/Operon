import type { Harness, HarnessSession, SessionConfig, SessionIdentity } from 'operon-agents'
import {
  budgetExceeded,
  PEERS_SERVICE,
  type AgentRef,
  type PeerCounters,
  type PeerFleetStats,
  type PeerNetworkHandle,
  type PeersSettings,
  type TeammateIdentity,
} from 'operon-agents-peers'
import { getChatStorage, getSessionManager } from '../ai/state.js'
import { workspaceSessionConfig, type WorkspaceSessionSetup } from './session-lifecycle.js'
import { resolveMcpServersForSession } from '../mcp-config.js'
import { ensurePluginsLoaded } from './plugins.js'
import { SPEC_CHAT_HINT } from '../spec/prompts.js'

/**
 * Operon's side of Teams.
 *
 * Teams itself is a FILE extension (`server/src/extensions/peers`, distributed through the Operon
 * extension marketplace). It depends on nothing of this app: its teammate types and budget are its
 * own settings (declared in its manifest, stored and validated by the framework, edited through the
 * generic extension settings form), and what a teammate is born as — its prompt, title and model —
 * is decided by `peers()` itself.
 *
 * What is left here is what the HOST does for every session, teammates included:
 * - a teammate gets the workspace's private MCP servers and `config.toml` policy like any other
 *   session (the harness's `resolveSession`, see index.ts);
 * - a new teammate gets a chat row — its transcript in the sidebar — found through the harness's
 *   `onSessionOpened` with `teammateOf` (`createTeammateChat`);
 * - the Settings / Agent panel views of the roster (`rosterForSession`, `rosterAll`, `disbandTeam`).
 *
 * The network is the extension's HARNESS half: one roster, mailbox and budget for the whole
 * process, alive from the moment the extension is loaded until it is unloaded.
 */

export interface PeersHostDeps {
  harness: () => Harness | undefined
  /**
   * A project root's session-private MCP servers + `config.toml` permission policy. The
   * workspace's `mcp.json` servers are not among them: every session there, a teammate too,
   * borrows those from the project's shared pool in the harness `sessionCapabilities` hook.
   */
  workspaceSetup: (cwd: string) => Promise<WorkspaceSessionSetup>
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

/** What the Teams extension is configured with right now: its settings, as the framework resolved
 *  them. Empty when the extension is not installed. */
export async function peersSettings(): Promise<PeersSettings> {
  const manager = deps?.harness()?.extensions
  if (!manager) return {}
  try {
    return ((await manager.getSettings(PEERS_SERVICE))?.value ?? {}) as PeersSettings
  } catch {
    // Not installed (no folder under the extensions dir): nothing is configured.
    return {}
  }
}

/**
 * The host's part of a session's setup when it is restored without the UI handing one in: a peer
 * message to a recipient that is not loaded (`host.resumeSession`), or any other bare
 * `harness.resumeSession(id)`. Called from the harness's `resolveSession`, which lays it over
 * what the session stored, so its own model, mode, prompt and extension parameters (a teammate's
 * seat and standing orders) survive. The conversation-scoped MCP servers are rebuilt from the chat
 * record because they carry this process's ports and identities.
 */
export async function restoredSessionConfig(session: Pick<SessionIdentity, 'id' | 'workDir'>): Promise<SessionConfig> {
  if (!deps) throw new Error('peers host not configured')
  const setup = await deps.workspaceSetup(session.workDir)
  const record = getSessionManager().findBySessionId(session.id)
  const storage = getChatStorage()
  const chat = storage?.findChatBySessionId(session.id)
    ?? (record ? withId(storage?.getChatMeta(record.chatId), record.chatId) : undefined)
  // A teammate's prompt was written into its stored setup when it was created; naming none here
  // keeps it (an `appendSystemPrompt` given would replace it).
  const instructions = chat?.metadata?.peer
    ? undefined
    : record?.params.instructions ?? (chat?.tp === 'chat' && chat.workspaceId != null ? SPEC_CHAT_HINT : undefined)
  await ensurePluginsLoaded()
  const servers = chat?.metadata?.workflowAgent ? {} : record?.params.mcpServers
    ?? (chat ? resolveMcpServersForSession('custom', { chatId: chat.id, cwd: session.workDir }) : undefined)
  return workspaceSessionConfig(
    { ...setup, servers: (servers ?? setup.servers) as WorkspaceSessionSetup['servers'] },
    instructions,
  )
}

/**
 * Make a newly spawned teammate a conversation in the sidebar: the chat row that is its
 * transcript, filed under its lead's workspace. Called from the harness's `onSessionOpened` for a
 * create, so the row exists before the teammate's first turn. Throws when the row cannot be made —
 * the harness then rolls the spawn back and the lead is told, instead of a teammate running that
 * nobody can see.
 */
export async function createTeammateChat(
  session: HarnessSession,
  member: TeammateIdentity,
  source: { readonly id: string } | undefined,
  defaultModelId: () => Promise<string>,
): Promise<void> {
  const storage = getChatStorage()
  if (!storage) return
  const leadSessionId = source?.id ?? member.creatorSessionId
  // The lead is mid-turn right now (it is the turn that spawned us), and a chat's session id
  // only lands on its row when the turn ends — so on a lead's FIRST turn the row lookup misses.
  // The session manager still knows which chat is driving that session.
  const leadRecord = leadSessionId ? getSessionManager().findBySessionId(leadSessionId) : undefined
  const leadChat = leadSessionId
    ? (storage.findChatBySessionId(leadSessionId)
        ?? (leadRecord ? withId(storage.getChatMeta(leadRecord.chatId), leadRecord.chatId) : undefined))
    : undefined
  const typeTitle = (await peersSettings()).types?.[member.type]?.title ?? member.type
  // The model was settled by Teams (the type's, or the lead's); the row shows what it runs on.
  const model = typeof session.modelSetting === 'string' ? session.modelSetting : await defaultModelId()
  storage.createChat({
    tp: 'teammate',
    title: `${member.name} · ${typeTitle}`,
    workspaceId: leadChat?.workspaceId,
    model,
    providerId: 'custom',
    sessionId: session.id,
    updatedAt: Date.now(),
    metadata: {
      peer: {
        name: member.name,
        team: member.team,
        type: member.type,
        creatorSessionId: leadSessionId ?? '',
        ...(leadChat ? { leadChatId: leadChat.id } : {}),
      },
    },
  })
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
  const net = harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE)
  if (!(await net.list()).some((ref) => ref.labels?.includes(label))) throw new Error(`No team ${label} on the roster`)
  const { members } = await net.disbandTeam(label)
  for (const ref of members) await harness.closeSession(ref.sessionId).catch(() => undefined)
  return { members: members.length }
}

/** The process-wide peer network (a handle; resolves at call time), when Teams is loaded. */
function network(): PeerNetworkHandle | undefined {
  const harness = deps?.harness()
  if (!harness || !harness.services.has(PEERS_SERVICE)) return undefined
  return harness.services.handle<PeerNetworkHandle>(PEERS_SERVICE)
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
  budget: NonNullable<PeersSettings['budget']>
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

async function toMemberDTO(ref: AgentRef, settings: PeersSettings): Promise<PeerMemberDTO> {
  const storage = getChatStorage()
  const cfg = settings.types?.[ref.type]
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

async function groupTeams(refs: readonly AgentRef[], leads: readonly AgentRef[], settings: PeersSettings): Promise<PeerTeamDTO[]> {
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
    const member = await toMemberDTO(ref, settings)
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

/** Spend across the network, as one table. */
function statsDTO(stats: PeerFleetStats, settings: PeersSettings, teams: PeerTeamDTO[]): PeersStatsDTO {
  const budget = settings.budget ?? {}
  const exceeded = budgetExceeded(stats, budget)
  const agents = stats.agents
    // A row that never spent anything is noise — every mounted hub registers one.
    .filter((a) => a.totalTokens > 0)
    .map((a) => ({ ...a, ...labelAgent(a.agentId, teams) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
  return { totals: stats.totals, agents, budget, ...(exceeded ? { exceeded } : {}) }
}

function typesDTO(settings: PeersSettings): PeersRosterDTO['types'] {
  return Object.entries(settings.types ?? {}).map(([id, t]) => ({ id, title: t.title, ...(t.description ? { description: t.description } : {}) }))
}

/** Teams created by `sessionId` (a lead's chat) — what the Agent panel's Team section shows. */
export async function rosterForSession(sessionId: string): Promise<PeersRosterDTO> {
  const settings = await peersSettings()
  const net = network()
  if (!net) return { available: false, teams: [], stats: null, types: typesDTO(settings) }
  const [members, self, stats] = await Promise.all([net.ownedMembers(sessionId), net.getAgent(sessionId), net.stats()])
  const teams = await groupTeams(members, self ? [self] : [], settings)
  return { available: true, teams, stats: statsDTO(stats, settings, teams), types: typesDTO(settings) }
}

/** Every team on the roster — the chat-less view for Settings. */
export async function rosterAll(): Promise<PeersRosterDTO> {
  const settings = await peersSettings()
  const net = network()
  if (!net) return { available: false, teams: [], stats: null, types: typesDTO(settings) }
  const [all, stats] = await Promise.all([net.list(), net.stats()])
  const members = all.filter((r) => r.kind === 'session' && r.type !== 'lead' && !isCreatorOnly(r))
  const leads = all.filter((r) => !members.includes(r))
  const teams = await groupTeams(members, leads, settings)
  return { available: true, teams, stats: statsDTO(stats, settings, teams), types: typesDTO(settings) }
}

/** A creator row: its labels are teams IT made (`team:<self>:…`), never memberships. */
function isCreatorOnly(ref: AgentRef): boolean {
  const labels = ref.labels ?? []
  return labels.length > 0 && labels.every((l) => parseTeamLabel(l)?.creatorSessionId === ref.agentId)
}
