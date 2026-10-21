/**
 * Sub-agents that are running right now, so a person watching one can talk to
 * it, or hand its work to another provider.
 *
 * A sub-agent is a chat (see `dispatch.ts`), so a message to it is a steer into
 * that chat's running turn — the same call a chat's composer makes — and is
 * stored in its transcript like any other steer. This table only maps a run row
 * to the chat that is working for it now, and holds the handoff.
 */

import { injectIntoChat } from '../ai/session-ops.js'
import type { AgentSeat } from './dispatch.js'

interface LiveAgent {
  chatId: number
  providerId: string
  /** Stops this agent's turn and runs the same prompt again on `to`. */
  replace: (to: AgentSeat) => void
}

const live = new Map<string, LiveAgent>()

const key = (runId: string, index: number) => `${runId}#${index}`

/** Make a running sub-agent reachable; call the returned function when it ends. */
export function trackLiveAgent(runId: string, index: number, agent: LiveAgent): () => void {
  const k = key(runId, index)
  live.set(k, agent)
  return () => {
    if (live.get(k) === agent) live.delete(k)
  }
}

export type SteerResult = { success: true } | { success: false; error: string }

/** Add a message to the turn a running sub-agent is in. */
export async function steerLiveAgent(runId: string, index: number, text: string): Promise<SteerResult> {
  const trimmed = text.trim()
  if (!trimmed) return { success: false, error: 'Message is empty' }
  const agent = live.get(key(runId, index))
  if (!agent) return { success: false, error: 'This agent is not running' }
  const result = await injectIntoChat(agent.chatId, trimmed)
  if (result.success) return { success: true }
  return {
    success: false,
    error:
      result.error === 'Current provider does not support steer'
        ? `${agent.providerId} does not accept messages while it works`
        : (result.error ?? 'The message could not be delivered'),
  }
}

/**
 * Hand a running sub-agent's work to another provider: its turn stops and the
 * same prompt starts over there, in the same run row. For an agent that is stuck
 * or going nowhere — without stopping the run around it.
 */
export function replaceLiveAgent(runId: string, index: number, to: AgentSeat): SteerResult {
  const agent = live.get(key(runId, index))
  if (!agent) return { success: false, error: 'This agent is not running' }
  if (to.providerId === agent.providerId && !to.modelId) {
    return { success: false, error: `This agent is already running on ${to.providerId}` }
  }
  agent.replace(to)
  return { success: true }
}
