import {
  RuntimeInjectionUnavailableError,
  type AgentInput, type AgentSession, type PermissionDecision, type SessionPatch, type SessionPatchApplied,
} from '@operon/agent-runtime'
import { SUPPORTED_EXTERNAL_AGENT_IDS } from '@shared/external-agent'
import type {
  DelegationControl, DelegationControlResult, DelegationFrame, DelegationSessionOptions, DelegationTurnRequest, DelegationWorkspace,
  IncomingDelegation,
} from '@shared/delegations'
import type { ProjectStorageAdapter, StorageAdapter } from '../storage/interface.js'
import { agentModelCatalog, type AgentModelCatalogEntry } from './agents/model-catalog.js'
import { getProviderModels, getProviders } from './ai/providers.js'
import { getSessionManager } from './ai/state.js'
import { DelegationHttpError } from './delegation-transport.js'

/**
 * The target side of a remote external agent: runs agent sessions for other
 * machines of the account, one per conversation they started.
 *
 * Holds no conversation. The origin keeps the transcript; a session here is the
 * provider process plus its native thread, which the origin resumes by id after
 * this machine restarts or the session idles out.
 */

export type DelegationHostStorage = StorageAdapter & ProjectStorageAdapter

interface HostedSession {
  key: string
  sourceNodeId: string
  sourceLabel?: string
  sessionId: string
  providerId: string
  workspaceId: number
  options: DelegationSessionOptions
  session: AgentSession
  turn?: AbortController
  updatedAt: number
}

const ENABLED_KEY = 'delegations:accepting'
const RECENT_KEY = 'delegations:recent'
const RECENT_LIMIT = 30
const IDLE_CLOSE_MS = 30 * 60_000
const RECONFIGURABLE = ['model', 'mode', 'effort', 'serviceTier'] as const

export function delegationProviderIds(): string[] {
  return getProviders().filter((provider) => provider.available &&
    (SUPPORTED_EXTERNAL_AGENT_IDS as readonly string[]).includes(provider.id)).map(({ id }) => id)
}

function sameOptions(a: DelegationSessionOptions, b: DelegationSessionOptions): boolean {
  return RECONFIGURABLE.every((field) => a[field] === b[field])
}

export class DelegationHost {
  private readonly sessions = new Map<string, HostedSession>()
  private sweeper?: ReturnType<typeof setInterval>

  constructor(private readonly storage: DelegationHostStorage) {}

  init(): () => void {
    this.sweeper = setInterval(() => this.closeIdle(), 60_000)
    this.sweeper.unref()
    return () => {
      clearInterval(this.sweeper)
      for (const hosted of this.sessions.values()) void this.close(hosted)
    }
  }

  accepting(): boolean { return this.storage.get(ENABLED_KEY) === true }

  setAccepting(enabled: boolean): void {
    this.storage.set(ENABLED_KEY, enabled)
    if (!enabled) for (const hosted of this.sessions.values()) hosted.turn?.abort()
  }

  recent(): IncomingDelegation[] {
    return this.storage.get<IncomingDelegation[]>(RECENT_KEY) ?? []
  }

  private requireAccepting(): void {
    if (!this.accepting()) throw new DelegationHttpError(403, 'This machine is not accepting remote agents', 'delegations_disabled')
  }

  private requireProvider(providerId: string): void {
    const providers = delegationProviderIds()
    if (!providers.includes(providerId)) {
      throw new DelegationHttpError(400, `Available agents on this machine: ${providers.join(', ') || 'none'}`)
    }
  }

  async catalog(providerIds?: string[], query?: string, models?: string): Promise<{ agents: AgentModelCatalogEntry[]; workspaces: DelegationWorkspace[] }> {
    this.requireAccepting()
    for (const id of providerIds ?? []) this.requireProvider(id)
    const available = providerIds?.length ? providerIds : delegationProviderIds()
    const workspaces = this.storage.listProjects().flatMap((project) => this.storage.listWorkspaces(project.id)
      .map(({ id, name }) => ({ id, name, project: project.name })))
    const agents: AgentModelCatalogEntry[] = models === '0'
      ? available.map((agentType) => ({ agentType }))
      : await agentModelCatalog(available, query, 'external_agent_list_models', models === 'full')
    return { agents, workspaces }
  }

  /** The provider's model / mode catalog, the same answer as this machine's own composer gets. */
  async models(providerId: string) {
    this.requireAccepting()
    this.requireProvider(providerId)
    return getProviderModels(providerId)
  }

  private keyOf(source: string, sessionId: string): string { return `${source}:${sessionId}` }

  private async hosted(source: string, sourceLabel: string | undefined, sessionId: string, request: DelegationTurnRequest): Promise<HostedSession> {
    const key = this.keyOf(source, sessionId)
    const current = this.sessions.get(key)
    if (current && current.providerId === request.providerId && current.workspaceId === request.workspaceId) {
      if (sameOptions(current.options, request.options)) return current
      if (await this.reconfigure(current, request.options)) return current
    }
    if (current) await this.close(current)
    const workspace = this.storage.getWorkspace(request.workspaceId)
    if (!workspace) throw new DelegationHttpError(409, 'The workspace on this machine no longer exists')
    const { model, mode, effort, serviceTier, resume } = request.options
    const session = await getSessionManager().createStandaloneSession(request.providerId, {
      cwd: workspace.worktreePath, model, mode, effort, serviceTier, resume,
    })
    const hosted: HostedSession = { key, sourceNodeId: source, sourceLabel, sessionId, providerId: request.providerId,
      workspaceId: request.workspaceId, options: { ...request.options }, session, updatedAt: Date.now() }
    this.sessions.set(key, hosted)
    return hosted
  }

  private async reconfigure(hosted: HostedSession, next: DelegationSessionOptions): Promise<boolean> {
    if (typeof hosted.session.set !== 'function') return false
    const patch: SessionPatch = {}
    const changed: SessionPatchApplied = []
    for (const field of RECONFIGURABLE) {
      if (hosted.options[field] === next[field]) continue
      if (next[field] === undefined && field !== 'serviceTier') continue
      Object.assign(patch, { [field]: next[field] })
      changed.push(field)
    }
    const applied = changed.length ? await hosted.session.set(patch) : []
    if (!changed.every((field) => applied.includes(field))) return false
    hosted.options = { ...hosted.options, ...patch }
    return true
  }

  async *turn(source: string, sourceLabel: string | undefined, sessionId: string, request: DelegationTurnRequest,
    input: AgentInput, signal: AbortSignal): AsyncGenerator<DelegationFrame> {
    this.requireAccepting()
    this.requireProvider(request.providerId)
    const hosted = await this.hosted(source, sourceLabel, sessionId, request)
    hosted.turn?.abort()
    const turn = new AbortController()
    hosted.turn = turn
    const stop = () => turn.abort()
    // The origin closing the stream is its stop: it aborted the turn or lost the connection.
    signal.addEventListener('abort', stop, { once: true })
    turn.signal.addEventListener('abort', () => hosted.session.abort(), { once: true })
    this.remember(hosted, 'running')
    try {
      // Always first: it is what opens the response, before the model has said anything.
      yield { type: 'state', state: hosted.session.state?.() ?? {} }
      for await (const part of hosted.session.send(input, { signal: turn.signal })) {
        yield { type: 'part', part }
      }
      const after = hosted.session.state?.()
      if (after) yield { type: 'state', state: after }
    } catch (error) {
      if (!turn.signal.aborted) yield { type: 'error', message: error instanceof Error ? error.message : 'The agent failed' }
    } finally {
      signal.removeEventListener('abort', stop)
      if (hosted.turn === turn) hosted.turn = undefined
      hosted.updatedAt = Date.now()
      this.remember(hosted, 'idle')
    }
  }

  async control(source: string, sessionId: string, control: DelegationControl): Promise<DelegationControlResult> {
    const hosted = this.sessions.get(this.keyOf(source, sessionId))
    if (control.type === 'abort') { hosted?.turn?.abort(); return { ok: true } }
    if (control.type === 'close') { if (hosted) await this.close(hosted); return { ok: true } }
    if (!hosted) throw new DelegationHttpError(409, 'The agent session on this machine has ended', 'session_missing')
    hosted.updatedAt = Date.now()
    switch (control.type) {
      case 'respond':
        return { ok: true, accepted: hosted.session.respond(control.approvalId, control.decision as PermissionDecision) }
      case 'set': {
        this.requireAccepting()
        if (typeof hosted.session.set !== 'function') return { ok: true, applied: [] }
        const patch: SessionPatch = {}
        for (const field of RECONFIGURABLE) {
          if (!(field in control.patch)) continue
          Object.assign(patch, { [field]: control.patch[field] ?? undefined })
        }
        const applied = await hosted.session.set(patch)
        for (const field of applied) Object.assign(hosted.options, { [field]: patch[field] })
        return { ok: true, applied, state: hosted.session.state?.() }
      }
      case 'steer':
      case 'followup': {
        this.requireAccepting()
        const deliver = hosted.session[control.type]
        if (!deliver) throw new DelegationHttpError(400, `This agent does not support ${control.type}`)
        try {
          const receipt = await deliver.call(hosted.session, control.input as AgentInput, control.id ? { id: control.id } : undefined)
          return { ok: true, receipt }
        } catch (error) {
          if (error instanceof RuntimeInjectionUnavailableError) throw new DelegationHttpError(409, error.message, 'injection_unavailable')
          throw error
        }
      }
    }
  }

  private async close(hosted: HostedSession): Promise<void> {
    if (this.sessions.get(hosted.key) === hosted) this.sessions.delete(hosted.key)
    hosted.turn?.abort()
    this.remember(hosted, 'closed')
    await hosted.session.close('discard').catch((error) => console.warn('[delegations] could not close a session:', error))
  }

  private closeIdle(): void {
    const cutoff = Date.now() - IDLE_CLOSE_MS
    for (const hosted of this.sessions.values()) {
      if (!hosted.turn && hosted.updatedAt < cutoff) void this.close(hosted)
    }
  }

  /** A bounded list for Remote settings: what other machines have been running here. */
  private remember(hosted: HostedSession, status: IncomingDelegation['status']): void {
    const workspace = this.storage.getWorkspace(hosted.workspaceId)
    const entry: IncomingDelegation = { sessionId: hosted.sessionId, sourceNodeId: hosted.sourceNodeId, sourceLabel: hosted.sourceLabel,
      providerId: hosted.providerId, workspace: workspace?.name, status, updatedAt: Date.now() }
    const rest = this.recent().filter((item) => item.sessionId !== hosted.sessionId || item.sourceNodeId !== hosted.sourceNodeId)
    this.storage.set(RECENT_KEY, [entry, ...rest].slice(0, RECENT_LIMIT))
  }
}
