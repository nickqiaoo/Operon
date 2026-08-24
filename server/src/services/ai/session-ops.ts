import type { UIMessage } from 'ai'
import { getSessionManager } from './state.js'
import { createSteerUserMessage } from './helpers.js'
import { persistInjectedUserMessageWithRetry } from './persistence.js'
import { isAgentOwnedChat } from '../channel/agent-orchestrator.js'
import { getClaudeAccountUsage } from '@operon/agent-runtime'
import type {
  DetailedContextUsage,
  DynamicSetPayload,
  RuntimeGoal,
  RuntimeUsageLimits,
} from '@operon/agent-runtime'

// Only a stampede guard for concurrent clients — the poll interval, not this,
// decides how fresh the number is.
const CLAUDE_USAGE_CACHE_TTL_MS = 10_000

let claudeUsageCache: { data: RuntimeUsageLimits; fetchedAt: number } | null = null
let claudeUsageInFlight: Promise<RuntimeUsageLimits | null> | null = null

export function handleSessionCleanup(chatId: number): boolean {
  const sessionManager = getSessionManager()
  // Don't destroy sessions owned by channel agents — closing the UI tab should not kill the agent
  if (isAgentOwnedChat(chatId)) {
    console.log(`[Adapter] Skipping cleanup for agent-owned session chatId=${chatId}`)
    return true
  }
  sessionManager.destroy(chatId).catch((err) => {
    console.error(`[Adapter] Failed to cleanup session ${chatId}:`, err)
  })
  return true
}

export function abortChat(chatId: number): boolean {
  const sessionManager = getSessionManager()
  const session = sessionManager.get(chatId)
  if (!session) return false
  try {
    const activeRequest = session.activeRequest
    if (activeRequest) {
      activeRequest.abortController.abort()
      sessionManager.finishRequest(chatId, activeRequest.requestId)
    }
    session.runtime.abort()
    return true
  } catch (err) {
    console.error(`[Adapter] Failed to abort ${chatId}:`, err)
    return false
  }
}

export async function injectIntoChat(
  chatId: number,
  content: string,
  turnMessageId?: string,
): Promise<{ success: boolean; error?: string; message?: UIMessage }> {
  const sessionManager = getSessionManager()
  const trimmed = content.trim()
  if (!trimmed) {
    return { success: false, error: 'Message is empty' }
  }

  const session = sessionManager.get(chatId)
  if (!session) {
    console.warn(`[AI] injectIntoChat(${chatId}): session not found`)
    return { success: false, error: 'Session not found' }
  }

  if (!session.activeRequest) {
    console.warn(`[AI] injectIntoChat(${chatId}): no active request — session may have already finished`)
    return { success: false, error: 'Session is not currently generating' }
  }

  if (typeof session.runtime.injectMessage !== 'function') {
    console.warn(`[AI] injectIntoChat(${chatId}): provider does not support inject`)
    return { success: false, error: 'Current provider does not support steer' }
  }

  try {
    await session.runtime.injectMessage(trimmed)
    const steerMessage = createSteerUserMessage(trimmed, turnMessageId)
    const persistResult = persistInjectedUserMessageWithRetry(chatId, steerMessage)
    if (!persistResult.success) {
      return { success: false, error: persistResult.error ?? 'Failed to persist steer message' }
    }
    return { success: true, message: steerMessage }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to inject message'
    console.error(`[AI] Inject failed for chat ${chatId}:`, error)
    return { success: false, error: message }
  }
}

/**
 * Get detailed context usage breakdown from an active Claude Code session.
 */
export async function getContextUsage(
  chatId: number,
): Promise<{ success: boolean; data?: DetailedContextUsage; error?: string }> {
  const sessionManager = getSessionManager()
  const session = sessionManager.get(chatId)
  if (!session) return { success: false, error: 'No active session' }
  if (typeof session.runtime.getContextUsage !== 'function') {
    return { success: false, error: 'Provider does not support context usage' }
  }
  try {
    const data = await session.runtime.getContextUsage()
    if (!data) return { success: false, error: 'No context usage available' }
    return { success: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AI] getContextUsage failed for chat ${chatId}:`, message)
    return { success: false, error: message }
  }
}

/**
 * Read Claude subscription quota. The value is account-scoped and comes from a
 * dedicated chat-less probe process, so it needs no open conversation and never
 * competes with a live message stream. The cache and single-flight here only
 * keep N polling clients from stacking control requests on that one probe.
 */
export async function getClaudeUsageLimits(): Promise<{
  success: boolean
  data?: RuntimeUsageLimits
  error?: string
}> {
  if (claudeUsageCache && Date.now() - claudeUsageCache.fetchedAt < CLAUDE_USAGE_CACHE_TTL_MS) {
    return { success: true, data: claudeUsageCache.data }
  }

  if (claudeUsageInFlight) {
    try {
      const data = await claudeUsageInFlight
      return data
        ? { success: true, data }
        : { success: false, error: 'No Claude usage data available' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return claudeUsageCache
        ? { success: true, data: claudeUsageCache.data }
        : { success: false, error: message }
    }
  }

  const request = getClaudeAccountUsage()
  claudeUsageInFlight = request
  try {
    const data = await request
    if (!data) {
      return claudeUsageCache
        ? { success: true, data: claudeUsageCache.data }
        : { success: false, error: 'No Claude usage data available' }
    }
    claudeUsageCache = { data, fetchedAt: Date.now() }
    return { success: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[AI] getClaudeUsageLimits failed:', message)
    return claudeUsageCache
      ? { success: true, data: claudeUsageCache.data }
      : { success: false, error: message }
  } finally {
    if (claudeUsageInFlight === request) {
      claudeUsageInFlight = null
    }
  }
}

/**
 * Invoke a provider-supported runtime-control method on the chat's session.
 * Generic method+params in, JSON result out — the desktop Session panel drives
 * this over an HTTP route.
 */
export async function agentControl(
  chatId: number,
  method: string,
  params: unknown,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const sessionManager = getSessionManager()
  const session = sessionManager.get(chatId)
  if (!session) return { success: false, error: 'No active session' }
  if (typeof session.runtime.agentControl !== 'function') {
    return { success: false, error: 'Current provider does not support agent control' }
  }
  try {
    const data = await session.runtime.agentControl(method, params)
    return { success: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AI] agentControl(${method}) failed for chat ${chatId}:`, message)
    return { success: false, error: message }
  }
}

/**
 * Dynamically switch model / permission mode on a live session.
 *
 * Named for Claude Code because it shipped first, but gated on the capability
 * rather than the provider id — every runtime implementing `dynamicSet` (Claude,
 * Operon, Copilot, OpenCode, ACP) can take the switch mid-turn.
 */
export async function handleCCDynamicSet(
  chatId: number,
  payload: DynamicSetPayload,
): Promise<{ success: boolean; error?: string }> {
  const sessionManager = getSessionManager()
  const session = sessionManager.get(chatId)
  if (!session) return { success: false, error: 'No active session' }

  try {
    if (typeof session.runtime.dynamicSet !== 'function') {
      return { success: false, error: 'This provider does not support dynamic updates' }
    }
    const applied = await session.runtime.dynamicSet(payload)
    // Keep the reuse fingerprint in step, or the next turn rebuilds the session
    // we just switched in place (and reconnects every MCP server with it). Fields
    // the runtime could not apply stay stale on purpose, so that rebuild still
    // happens for them.
    sessionManager.applyDynamicParams(chatId, payload, applied)
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AI] CC dynamic set failed for chat ${chatId}:`, message)
    return { success: false, error: message }
  }
}

/**
 * Read the current thread goal for a chat (for rehydrating the goal banner).
 * Returns goal: null when there is no session or no goal.
 */
export async function getChatGoal(
  chatId: number,
): Promise<{ success: boolean; goal?: RuntimeGoal | null; error?: string }> {
  const sessionManager = getSessionManager()
  const session = sessionManager.get(chatId)
  if (!session) return { success: true, goal: null }
  if (typeof session.runtime.getGoal !== 'function') {
    return { success: false, error: 'Current provider does not support goals' }
  }
  try {
    const goal = await session.runtime.getGoal()
    return { success: true, goal }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AI] getChatGoal failed for chat ${chatId}:`, message)
    return { success: false, error: message }
  }
}

/**
 * Clear the thread goal and abort any in-flight goal pursuit (toggle off /
 * delete from the banner).
 */
export async function clearChatGoal(
  chatId: number,
): Promise<{ success: boolean; error?: string }> {
  const sessionManager = getSessionManager()
  const session = sessionManager.get(chatId)
  if (!session) return { success: true }
  if (typeof session.runtime.clearGoal !== 'function') {
    return { success: false, error: 'Current provider does not support goals' }
  }
  try {
    // Stop the pursuit loop first, then clear the persisted goal.
    if (session.activeRequest) {
      session.activeRequest.abortController.abort()
      sessionManager.finishRequest(chatId, session.activeRequest.requestId)
    }
    await session.runtime.clearGoal()
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AI] clearChatGoal failed for chat ${chatId}:`, message)
    return { success: false, error: message }
  }
}

/**
 * Set the thread-goal status without streaming (used by the banner's pause
 * button). Resume (active) is driven through the chat stream instead.
 */
export async function setChatGoalStatus(
  chatId: number,
  status: 'active' | 'paused',
): Promise<{ success: boolean; goal?: RuntimeGoal | null; error?: string }> {
  const sessionManager = getSessionManager()
  const session = sessionManager.get(chatId)
  if (!session) return { success: false, error: 'No active session' }
  if (typeof session.runtime.setGoalStatus !== 'function') {
    return { success: false, error: 'Current provider does not support goals' }
  }
  try {
    if (status === 'paused' && session.activeRequest) {
      // Pausing stops the active pursuit loop (loop pauses on abort).
      session.activeRequest.abortController.abort()
      sessionManager.finishRequest(chatId, session.activeRequest.requestId)
      return { success: true }
    }
    const goal = await session.runtime.setGoalStatus(status)
    return { success: true, goal }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AI] setChatGoalStatus failed for chat ${chatId}:`, message)
    return { success: false, error: message }
  }
}
