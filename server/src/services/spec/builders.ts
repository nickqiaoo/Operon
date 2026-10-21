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
