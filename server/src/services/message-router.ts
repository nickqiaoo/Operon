/**
 * Three-state message routing common to channel / mate / linear (inbox).
 *
 * Status decides delivery for a binding:
 *   active  → debounce-inject [System notification: …] into the running chat
 *             (falls back to wake if the chat ended between status check and inject)
 *   idle    → wake: start a fresh turn with the platform's wake prompt
 *   offline → cold start: ensure workspace, then wake
 *
 * Each platform plugs in:
 *   - injectNotification(count) — text injected when binding is active
 *   - wakePrompt                — user message for idle/offline wake
 *   - ensureWorkspace?()        — provision worktree for offline bindings (channel/linear);
 *                                 mate skips when workspace already set by wizard
 *   - startChat(prompt)         — platform builds system prompt + MCP tools and starts the chat
 *
 * The router owns: 3-state dispatch, debounce, inject fallback, status updates.
 */

import type {
  AgentBindingStorageAdapter,
} from '../storage/interface.js'
import type { AgentBinding } from '../types/agent-binding.js'
import { injectIntoChat } from './ai.js'
import { debounceNotify } from './channel/debounce-manager.js'

const DEFAULT_DEBOUNCE_MS = 3000

export interface BindingDelivery {
  /** Target binding. Status field decides which path runs. */
  binding: AgentBinding
  /** Notification text injected when active. Receives debounced event count. */
  injectNotification: (count: number) => string
  /** User message used to start a fresh turn for idle / offline bindings. */
  wakePrompt: string
  /**
   * Provision (or look up) the worktree workspace_id for this binding.
   * Called only when status === 'offline'. Returns null to skip wake (e.g.
   * mate sees a binding without workspace_id and wants the upstream caller
   * to trigger setup-wizard rather than auto-wake).
   */
  ensureWorkspace?: () => Promise<number | null>
  /**
   * Start a fresh chat for this binding with the wake prompt as the user
   * message. Returns the new chatId. Platform owns system prompt assembly,
   * MCP tool injection, drain start, and any error surfacing.
   */
  startChat: (prompt: string, workspaceId: number | null) => Promise<number>
}

export interface RouteOptions {
  /** Override debounce window (default 3000ms). */
  debounceMs?: number
  /** Optional log prefix (e.g. 'Orchestrator', 'MateOrchestrator', 'Inbox'). */
  logTag?: string
}

/**
 * Deliver one message event to one binding.
 *
 * Caller resolves recipients first (e.g. channel: list_members; mate: the
 * one binding receiving this IM message; inbox: the recipient agent's
 * active linear binding) and invokes this function per binding.
 *
 * Errors are caught + logged; never thrown back. The binding's status is
 * left consistent on failure (reset to 'idle' so the next event can retry).
 */
export async function deliverToBinding(
  storage: AgentBindingStorageAdapter,
  delivery: BindingDelivery,
  options: RouteOptions = {},
): Promise<void> {
  const { binding } = delivery
  const tag = options.logTag ?? 'MessageRouter'
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const debounceKey = `binding:${binding.id}`

  if (binding.status === 'active' && binding.activeChatId != null) {
    const chatId = binding.activeChatId
    debounceNotify(debounceKey, debounceMs, (count) => {
      const text = delivery.injectNotification(count)
      injectIntoChat(chatId, text)
        .then((result) => {
          if (!result.success) {
            console.warn(
              `[${tag}] inject failed for binding=${binding.id} chat=${chatId}: ${result.error} — falling back to wake`,
            )
            // Session ended between status check and inject — reset and retry as wake.
            storage.updateBinding(binding.id, { status: 'idle' })
            wakeAndStart(storage, delivery, tag).catch((err) => {
              console.error(`[${tag}] fallback wake error for binding=${binding.id}:`, err)
            })
          }
        })
        .catch((err) => {
          console.error(`[${tag}] inject error for binding=${binding.id}:`, err)
        })
    })
    return
  }

  // idle / offline / completed — wake.
  await wakeAndStart(storage, delivery, tag)
}

/**
 * Wake an idle/offline binding: ensure workspace if needed, then start a chat.
 * Status is set 'active' before startChat (so a concurrent message routes via
 * inject path) and reverted to 'idle' on failure.
 */
async function wakeAndStart(
  storage: AgentBindingStorageAdapter,
  delivery: BindingDelivery,
  tag: string,
): Promise<void> {
  const { binding } = delivery
  let workspaceId = binding.workspaceId

  if (workspaceId == null && delivery.ensureWorkspace) {
    try {
      workspaceId = await delivery.ensureWorkspace()
    } catch (err) {
      console.error(
        `[${tag}] ensureWorkspace failed for binding=${binding.id} agent=${binding.agentId}:`,
        err,
      )
      return
    }
    if (workspaceId == null) {
      // Platform signalled "do not wake" (e.g. mate setup-wizard not yet completed).
      return
    }
    storage.updateBinding(binding.id, { workspaceId })
  }

  // Mark active before startChat so a fresh inbound message routes via inject path.
  storage.updateBinding(binding.id, { status: 'active' })

  let chatId: number
  try {
    chatId = await delivery.startChat(delivery.wakePrompt, workspaceId)
  } catch (err) {
    console.error(
      `[${tag}] startChat failed for binding=${binding.id} agent=${binding.agentId}:`,
      err,
    )
    storage.updateBinding(binding.id, { status: 'idle' })
    throw err
  }
  storage.updateBinding(binding.id, { activeChatId: chatId, status: 'active' })
}

/**
 * Reset a binding's status to 'idle' on chat finish. Caller (orchestrator)
 * is responsible for checking unread messages afterwards and re-waking if
 * needed — that logic stays platform-specific because the unread query
 * differs per stream (channel_messages vs im_messages vs inbox).
 */
export function markBindingIdle(
  storage: AgentBindingStorageAdapter,
  bindingId: number,
): void {
  storage.updateBinding(bindingId, { status: 'idle' })
}
