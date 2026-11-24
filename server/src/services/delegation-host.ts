import { SUPPORTED_EXTERNAL_AGENT_IDS } from '@shared/external-agent'
import type { DelegationWorkspace, IncomingDelegation } from '@shared/delegations'
import type { ProjectStorageAdapter, StorageAdapter } from '../storage/interface.js'
import { agentModelCatalog, type AgentModelCatalogEntry } from './agents/model-catalog.js'
import { getProviders } from './ai/providers.js'
import { abortChat } from './ai/session-ops.js'
import { DelegationHttpError } from './delegation-transport.js'
import { listExternalAgents } from './external-agent.js'

/**
 * This machine as a target for the account's other machines: the "Run agents
 * for other machines" switch, the catalog of agents and workspaces it offers,
 * and which of its external agents other machines started.
 *
 * Those agents are ordinary external agents of this machine (see
 * remote-agents.ts); nothing here runs or holds a session.
 */

export type DelegationHostStorage = StorageAdapter & ProjectStorageAdapter

const ENABLED_KEY = 'delegations:accepting'
const RECENT_LIMIT = 30

export function delegationProviderIds(): string[] {
  return getProviders().filter((provider) => provider.available &&
    (SUPPORTED_EXTERNAL_AGENT_IDS as readonly string[]).includes(provider.id)).map(({ id }) => id)
}

export class DelegationHost {
  constructor(private readonly storage: DelegationHostStorage) {}

  /** Kept for the app's lifecycle; there is nothing to sweep any more. */
  init(): () => void {
    return () => undefined
  }

  accepting(): boolean { return this.storage.get(ENABLED_KEY) === true }

  /** Turning it off also stops what other machines are running here. */
  setAccepting(enabled: boolean): void {
    this.storage.set(ENABLED_KEY, enabled)
    if (enabled) return
    for (const agent of listExternalAgents()) {
      if (agent.remoteParent && (agent.status === 'running' || agent.status === 'queued')) abortChat(agent.childChatId)
    }
  }

  /** For Remote settings: the agents other machines started here, newest first. */
  recent(): IncomingDelegation[] {
    const workspaces = new Map<number, string>()
    const workspaceName = (id: number | undefined) => {
      if (id == null) return undefined
      if (!workspaces.has(id)) workspaces.set(id, this.storage.getWorkspace(id)?.name ?? '')
      return workspaces.get(id) || undefined
    }
    return listExternalAgents()
      .flatMap((agent) => agent.remoteParent ? [{
        childChatId: agent.childChatId,
        sourceNodeId: agent.remoteParent.nodeId,
        ...(agent.remoteParent.label ? { sourceLabel: agent.remoteParent.label } : {}),
        providerId: agent.providerId,
        description: agent.description,
        ...(workspaceName(agent.workspaceId) ? { workspace: workspaceName(agent.workspaceId) } : {}),
        status: agent.status,
        updatedAt: agent.updatedAt ?? 0,
      }] : [])
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_LIMIT)
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
}
