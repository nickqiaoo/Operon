/**
 * Shared binding driver — the wake / finish control flow common to the
 * built-in channel orchestrator and the IM (slack/telegram) mate orchestrator.
 *
 * Before this module both orchestrators carried their own near-verbatim copy of
 *   - the 3-state dispatch (active→inject / idle→wake / offline→cold-start), and
 *   - the finish loop (cancel debounce → query unread → retry-breaker → re-wake / idle).
 * The only things that genuinely differ between platforms are captured by a
 * `BindingPlatformAdapter`: how to query unread, how to start a chat, and the
 * platform-specific side effects (breaker notice / idle event). The driver owns
 * the rest.
 *
 * What stays platform-specific (NOT here): message storage (channel_messages vs
 * im_messages), the agent tool surface, and `startChat` internals (system-prompt
 * assembly + MCP wiring + prompt selection) — those live behind the adapter.
 *
 * Task bindings (`scope_kind = 'task'`) register a degenerate adapter whose
 * unread count is always 0, so a finished task turn simply settles idle.
 */

import type { AgentBindingStorageAdapter } from '../storage/interface.js'
import type { AgentBinding } from '../types/agent-binding.js'
import { deliverToBinding } from './message-router.js'
import { registerAgentFinishCallback } from './ai.js'
import { cancelDebounce } from './channel/debounce-manager.js'

const DEBOUNCE_MS = 3000
/** Max consecutive wake-ups without unread decrease before giving up. */
export const MAX_IDLE_RETRIES = 3

type DriverStorage = AgentBindingStorageAdapter

/**
 * Per-binding circuit breaker. Counts consecutive finishes where the unread
 * count failed to decrease; trips after MAX_IDLE_RETRIES so a looping provider
 * error can't pin a binding in an endless active/wake cycle. Keyed by the
 * globally-unique binding id, so a single shared instance is safe across
 * platforms.
 */
class RetryTracker {
  private counters = new Map<number, { count: number; lastUnreadCount: number }>()

  /** Record a finish that still has `unreadCount` pending. Returns true if the breaker tripped. */
  record(bindingId: number, unreadCount: number): boolean {
    const tracker = this.counters.get(bindingId)
    if (tracker && unreadCount >= tracker.lastUnreadCount) {
      tracker.count++
      if (tracker.count >= MAX_IDLE_RETRIES) {
        this.counters.delete(bindingId)
        return true
      }
    } else {
      this.counters.set(bindingId, { count: 1, lastUnreadCount: unreadCount })
    }
    return false
  }

  clear(bindingId: number): void {
    this.counters.delete(bindingId)
  }
}

const retryTracker = new RetryTracker()

/** Clear a binding's retry/breaker state (e.g. on user-invoked /reset). */
export function clearBindingRetry(bindingId: number): void {
  retryTracker.clear(bindingId)
}

/**
 * Everything that differs between the built-in channel and the IM mate paths.
 * Adapter methods read their orchestrator's module-level storage at call time,
 * so they may be constructed before init runs.
 */
export interface BindingPlatformAdapter {
  /** Scope kinds this adapter owns (e.g. {'app'} or {'slack','telegram'}). */
  readonly scopeKinds: ReadonlySet<AgentBinding['scopeKind']>
  /** Log prefix, e.g. 'Orchestrator' | 'MateOrchestrator'. */
  readonly logTag: string
  /** Notification text injected into a running turn when the binding is active. */
  buildInjectNotification(binding: AgentBinding, count: number): string
  /**
   * Provision / look up the workspace_id for an offline binding. Returns null
   * to skip the wake (e.g. mate setup-wizard not completed yet).
   */
  ensureWorkspace(binding: AgentBinding): Promise<number | null>
  /**
   * Start a fresh chat for this binding and return the new chatId. Owns
   * system-prompt assembly, MCP tool wiring, drain start, and wake-prompt
   * selection (cold vs warm). MUST NOT mutate binding status / activeChatId —
   * the driver owns that.
   */
  startChat(binding: AgentBinding, workspaceId: number | null): Promise<number>
  /** How many unread messages remain for this binding's stream. */
  getUnreadCount(binding: AgentBinding): number
  /** Side effect when the breaker trips (post a system / IM notice). */
  onBreakerTrip(binding: AgentBinding, unreadCount: number): void | Promise<void>
  /** Side effect when the binding settles idle (e.g. emit agent_status). */
  onIdle(binding: AgentBinding): void
}

/**
 * Deliver an inbound message event to a binding via the shared 3-state router.
 * The wake prompt is owned by `adapter.startChat`, so the router's wakePrompt
 * field is an unused placeholder here.
 */
export async function deliverBinding(
  storage: DriverStorage,
  adapter: BindingPlatformAdapter,
  binding: AgentBinding,
): Promise<void> {
  await deliverToBinding(
    storage,
    {
      binding,
      injectNotification: (count) => adapter.buildInjectNotification(binding, count),
      wakePrompt: '', // adapter.startChat owns prompt selection
      ensureWorkspace: () => adapter.ensureWorkspace(binding),
      startChat: (_prompt, workspaceId) => adapter.startChat(binding, workspaceId),
    },
    { logTag: adapter.logTag, debounceMs: DEBOUNCE_MS },
  )
}

/**
 * Run the shared finish loop for a binding whose chat turn just ended:
 * cancel any pending inject debounce, re-wake if unread remains (guarded by the
 * retry breaker), otherwise settle idle. Platform specifics go through `adapter`.
 */
export async function handleBindingFinish(
  storage: DriverStorage,
  adapter: BindingPlatformAdapter,
  bindingId: number,
): Promise<void> {
  // Stale inject payload — the turn has drained. We either re-wake (the fresh
  // prompt already says "check_messages") or settle idle (no chat to inject).
  cancelDebounce(`binding:${bindingId}`)

  const binding = storage.getBinding(bindingId)
  if (!binding || !adapter.scopeKinds.has(binding.scopeKind)) {
    retryTracker.clear(bindingId)
    return
  }

  const unreadCount = adapter.getUnreadCount(binding)

  if (unreadCount > 0) {
    const workspaceId = binding.workspaceId
    if (workspaceId == null) {
      console.warn(
        `[${adapter.logTag}] handleBindingFinish: binding=${bindingId} has unread but no workspace — idling`,
      )
      storage.updateBinding(bindingId, { status: 'idle' })
      adapter.onIdle(binding)
      return
    }

    if (retryTracker.record(bindingId, unreadCount)) {
      console.warn(
        `[${adapter.logTag}] handleBindingFinish: binding=${bindingId} failed to process ` +
          `${unreadCount} unread after ${MAX_IDLE_RETRIES} attempts — idling to prevent loop`,
      )
      storage.updateBinding(bindingId, { status: 'idle' })
      await adapter.onBreakerTrip(binding, unreadCount)
      adapter.onIdle(binding)
      return
    }

    // Re-wake immediately for this binding.
    storage.updateBinding(bindingId, { status: 'active' })
    try {
      const chatId = await adapter.startChat(binding, workspaceId)
      storage.updateBinding(bindingId, { activeChatId: chatId, status: 'active' })
    } catch (err) {
      console.error(`[${adapter.logTag}] re-wake error for binding=${bindingId}:`, err)
      storage.updateBinding(bindingId, { status: 'idle' })
    }
  } else {
    retryTracker.clear(bindingId)
    console.log(`[${adapter.logTag}] handleBindingFinish: binding=${bindingId} no unread — idling`)
    storage.updateBinding(bindingId, { status: 'idle' })
    adapter.onIdle(binding)
  }
}

// ---- Adapter registry + unified finish dispatch ----

const adapterRegistry: BindingPlatformAdapter[] = []
let _dispatchInstalled = false

function sameScopeKinds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

/**
 * Register a platform adapter so the unified finish dispatch can route a
 * finished turn to it by scope kind. Idempotent per scope-kind set (re-init
 * replaces rather than duplicates).
 */
export function registerBindingAdapter(adapter: BindingPlatformAdapter): void {
  const i = adapterRegistry.findIndex((a) => sameScopeKinds(a.scopeKinds, adapter.scopeKinds))
  if (i >= 0) adapterRegistry[i] = adapter
  else adapterRegistry.push(adapter)
}

function adapterFor(scopeKind: AgentBinding['scopeKind']): BindingPlatformAdapter | undefined {
  return adapterRegistry.find((a) => a.scopeKinds.has(scopeKind))
}

/**
 * Install the single agent-finish callback that dispatches every finished turn
 * to the registered adapter for its binding's scope kind. Idempotent — only the
 * first call wires the callback; adapters resolve at fire time, so registration
 * order across orchestrators does not matter.
 */
export function initBindingFinishDispatch(storage: DriverStorage): void {
  if (_dispatchInstalled) return
  _dispatchInstalled = true
  registerAgentFinishCallback((chatId) => {
    const binding = storage.getBindingByActiveChatId(chatId)
    if (!binding) return
    const adapter = adapterFor(binding.scopeKind)
    if (!adapter) return
    handleBindingFinish(storage, adapter, binding.id).catch((err) => {
      console.error(`[BindingDriver] finish error binding=${binding.id}:`, err)
    })
  })
}
