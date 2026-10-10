import type { PermissionRule } from 'operon-agents'
import type { ApprovalIcon, AssistantGrant } from '../../../../shared/assistant.js'
import type { StorageAdapter } from '../../storage/interface.js'
import type { HostElicitationRequest } from '../ai/host-approval-broker.js'

const GRANTS_KEY = 'assistant:grants'

/** What a grant would cover, without its id and date. */
export type GrantKey = Pick<AssistantGrant, 'kind' | 'value' | 'title' | 'icon'>

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** `https://x.com/a/b` → `https://x.com` (what a grant matches) and `x.com` (what it is called). */
function siteOf(value: string): { origin: string; host: string } {
  try {
    const url = new URL(value)
    return { origin: url.origin, host: url.host }
  } catch {
    return { origin: value, host: value }
  }
}

/**
 * What an "Always allow" on a node_repl prompt would cover: an app or a Computer Use capability,
 * or a website. A prompt that is none of those (a file transfer…) has nothing to remember.
 */
export function grantKeyForElicitation(request: HostElicitationRequest): GrantKey | undefined {
  const meta = record(request.meta)
  if (meta.file_transfer) return undefined
  const params = record(meta.tool_params)
  if (meta.connector_id === 'computer-use') {
    const app = str(params.app)
    if (app) return { kind: 'app', value: app, title: `Control ${app}`, icon: 'app' }
    const capability = str(params.capability)
    return capability ? { kind: 'capability', value: capability, title: `Computer Use · ${capability}`, icon: 'app' } : undefined
  }
  const raw = str(meta.origin)
  if (!raw) return undefined
  const { origin, host } = siteOf(raw)
  return { kind: 'site', value: origin, title: `Open ${host}`, icon: 'globe' }
}

/** What an "Always allow" on a framework tool call covers: the rule the framework itself proposed. */
export function grantKeyForTool(toolName: string, approvalRule: string): GrantKey {
  const value = approvalRule || toolName
  const icon: ApprovalIcon = toolName === 'Bash' ? 'terminal' : toolName.startsWith('mcp__') ? 'tool' : 'file'
  return { kind: 'tool', value, title: value, icon }
}

/**
 * The assistant's standing "Always allow"s. Its own list, not the chats': a site or an app the
 * user trusts the assistant with does not widen what coding chats may do, and revoking one here
 * leaves the chats' settings alone. Kept in KV — a handful of entries.
 */
export class AssistantGrants {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly changed: (grants: AssistantGrant[]) => void,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Newest first. */
  list(): AssistantGrant[] {
    return this.storage.get<AssistantGrant[]>(GRANTS_KEY) ?? []
  }

  add(key: GrantKey): AssistantGrant {
    const existing = this.find(key.kind, key.value)
    if (existing) return existing
    const grant: AssistantGrant = { ...key, id: this.newId(), grantedAt: this.now() }
    this.save([grant, ...this.list()])
    return grant
  }

  remove(id: string): boolean {
    const grants = this.list()
    const next = grants.filter((g) => g.id !== id)
    if (next.length === grants.length) return false
    this.save(next)
    return true
  }

  find(kind: AssistantGrant['kind'], value: string): AssistantGrant | undefined {
    return this.list().find((g) => g.kind === kind && g.value.toLowerCase() === value.toLowerCase())
  }

  /** The grant that already answers this node_repl prompt, if any. */
  forElicitation(request: HostElicitationRequest): AssistantGrant | undefined {
    const key = grantKeyForElicitation(request)
    return key ? this.find(key.kind, key.value) : undefined
  }

  /** Tool grants as the framework's own allow rules, for a worker session being opened. */
  toolRules(): PermissionRule[] {
    return this.list()
      .filter((g) => g.kind === 'tool')
      .map((g) => ({ decision: 'allow', scope: 'user', pattern: g.value, reason: 'Always allowed for the assistant' }))
  }

  private save(grants: AssistantGrant[]): void {
    this.storage.set(GRANTS_KEY, grants)
    this.changed(grants)
  }
}
