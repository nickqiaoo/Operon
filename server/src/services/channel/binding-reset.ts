import type { AgentBinding } from '../../types/agent-binding.js'
import type { AgentBindingStorageAdapter } from '../../storage/interface.js'
import { abortChat } from '../ai.js'
import { getSessionManager } from '../ai/state.js'

/**
 * Canonical binding-reset routine. Tears down whatever runtime is attached to
 * this binding's chat (abort the active turn, destroy the warm session so the
 * CLI subprocess doesn't get orphaned) and clears the binding back to
 * `activeChatId: null, status: 'offline'`. The next message on this binding
 * will trigger a cold start.
 *
 * Works for every scopeKind — `app`, `slack`, `telegram`, `linear` — because
 * none of the steps touch scope-specific state. Per-scope tails (cursor
 * advance, debounce cancellation, etc.) are NOT in here; callers that need
 * them layer them on top.
 */
export async function resetBinding(
  storage: Pick<AgentBindingStorageAdapter, 'updateBinding'>,
  binding: AgentBinding,
): Promise<void> {
  if (binding.activeChatId) {
    abortChat(binding.activeChatId)
    // abortChat only cancels the active turn; the warm runtime subprocess
    // stays alive keyed by chatId. Since we're clearing chatId from the
    // binding, that subprocess would orphan — tear it down explicitly.
    await getSessionManager().destroy(binding.activeChatId).catch((err: unknown) => {
      console.warn(`[binding-reset] destroy session ${binding.activeChatId} failed:`, err)
    })
  }
  storage.updateBinding(binding.id, { activeChatId: null, status: 'offline' })
}
