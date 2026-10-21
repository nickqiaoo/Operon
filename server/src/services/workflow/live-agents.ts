/**
 * Sub-agents that are running right now, so a person watching one can talk to
 * it, or hand its work to another provider.
 *
 * A workflow sub-agent is a one-turn standalone session with no chat of its own:
 * nothing else holds it, so without this table there is no way to reach it while
 * it works — only to stop the whole run. A message goes in through the session's
 * own `inject` (the same steer a chat uses), and is noted in the agent's recorded
 * output so its transcript shows what it was told and when.
 */

import { randomUUID } from 'crypto'
import type { AgentSession } from '@operon/agent-runtime'
import type { AgentSeat } from './dispatch.js'

interface LiveAgent {
  session: AgentSession
  providerId: string
  /** Records the message in the agent's own output stream. */
  note: (text: string, id: string) => void
  /** Stops this session and runs the same prompt again on `to`. */
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
  if (typeof agent.session.inject !== 'function') {
    return { success: false, error: `${agent.providerId} does not accept messages while it works` }
  }
  const id = randomUUID()
  try {
    await agent.session.inject(trimmed, { id })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
  agent.note(trimmed, id)
  return { success: true }
}

/**
 * Hand a running sub-agent's work to another provider: its session stops and the
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
