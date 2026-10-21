/**
 * The agents that build spec tickets.
 *
 * A ticket runs as an ordinary task session (`dispatchProjectTask`), and a task
 * session belongs to an agent record. Seats in a spec are a provider plus an
 * optional model, so each seat gets one hidden, reusable builder agent — created
 * the first time a spec needs it, never shown in agent pickers, but its sessions
 * open and can be taken over like any task's. Same pattern as the hidden
 * Workspace Assistant.
 */

import type { ChannelStorageAdapter } from '../../storage/interface.js'
import type { Agent } from '../../types/channel.js'
import type { SpecSeat } from '../../types/spec.js'
import { subagentMode } from '../agents/subagent-mode.js'
import { COORDINATOR_INSTRUCTIONS } from './prompts.js'

export type BuilderStorage = Pick<ChannelStorageAdapter, 'getAgentByName' | 'createAgent'>

export function builderAgentName(seat: SpecSeat): string {
  return seat.modelId ? `Spec builder · ${seat.providerId} · ${seat.modelId}` : `Spec builder · ${seat.providerId}`
}

export function getOrCreateSpecBuilder(storage: BuilderStorage, seat: SpecSeat): Agent {
  const name = builderAgentName(seat)
  const existing = storage.getAgentByName(name)
  if (existing) return existing
  return storage.createAgent({
    name,
    provider: seat.providerId,
    // A task session runs on its agent's model, so the seat's model has to live
    // here; an empty one is the provider's own default.
    model: seat.modelId ?? '',
    instructions: '',
    // Nobody sits in front of a ticket session; a mode that stops to ask would
    // stall it. The same unattended mode Workflow sub-agents run in.
    permissionMode: subagentMode(seat.providerId),
    hidden: true,
  })
}

export function coordinatorAgentName(seat: SpecSeat): string {
  return seat.modelId ? `Spec coordinator · ${seat.providerId} · ${seat.modelId}` : `Spec coordinator · ${seat.providerId}`
}

/**
 * The hidden agent that coordinates specs from a seat — the lead's. Like the
 * builders, one per seat serves every spec; each spec has its own session (a
 * task binding on the spec) in its change worktree.
 */
export function getOrCreateSpecCoordinator(storage: BuilderStorage, seat: SpecSeat): Agent {
  const name = coordinatorAgentName(seat)
  const existing = storage.getAgentByName(name)
  if (existing) return existing
  return storage.createAgent({
    name,
    provider: seat.providerId,
    model: seat.modelId ?? '',
    instructions: COORDINATOR_INSTRUCTIONS,
    // Woken by events with nobody at the screen, like a ticket session.
    permissionMode: subagentMode(seat.providerId),
    hidden: true,
  })
}
