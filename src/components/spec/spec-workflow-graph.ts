import type { SpecAgentRun, SpecTicket } from '@shared/spec'
import type { WorkflowPhaseId } from './spec-workflow-data'

export interface WorkflowGraphNode {
  id: string
  call: SpecAgentRun
  parents: string[]
  column: number
  row: number
}

const idOf = (call: SpecAgentRun) => `${call.runId}:${call.index}`
const roleOf = (call: SpecAgentRun) => call.label.split(' · ')[0].toLowerCase()

/** Mirrors the Spec runner: parallel role calls, per-branch retries, then barriers. */
export function specWorkflowGraph(phase: WorkflowPhaseId, calls: SpecAgentRun[], tickets: SpecTicket[] = []): WorkflowGraphNode[] {
  const nodes: WorkflowGraphNode[] = []
  const byId = new Map<string, WorkflowGraphNode>()
  const branchRows = new Map<string, number>()
  const tails = new Map<string, string>()
  let barrier: string | undefined
  let gathering = false

  function add(call: SpecAgentRun, parents: string[], branch?: string) {
    const dependencies = [...new Set(parents)].filter((id) => byId.has(id))
    const previous = dependencies.map((id) => byId.get(id)!)
    if (branch && !branchRows.has(branch)) branchRows.set(branch, branchRows.size)
    const row = branch ? branchRows.get(branch)! : previous.length ? previous.reduce((sum, node) => sum + node.row, 0) / previous.length : 0
    const node = { id: idOf(call), call, parents: dependencies, column: previous.length ? Math.max(...previous.map((node) => node.column)) + 1 : 0, row }
    nodes.push(node)
    byId.set(node.id, node)
    return node.id
  }

  for (const call of calls) {
    const role = roleOf(call)
    if (phase === 'build') {
      const key = tickets.find((ticket) => new RegExp(`\\b${ticket.key}\\b`, 'i').test(call.label))?.key ?? 'coordination'
      const blockers = tickets.find((ticket) => ticket.key === key)?.blockedBy ?? []
      const parents = tails.has(key) ? [tails.get(key)!] : blockers.flatMap((blocker) => tails.has(blocker) ? [tails.get(blocker)!] : [])
      tails.set(key, add(call, parents, key))
      continue
    }

    const parallel = phase === 'explore' ? role === 'explorer' : phase === 'design' ? role.startsWith('candidate ') : phase === 'verify' ? role === 'review change' : false
    if (parallel) {
      if (!gathering) { tails.clear(); gathering = true }
      const label = call.label.replace(/\s*\(retry \d+\)$/, '')
      const suffix = call.agentType ? ` · ${call.agentType}` : ''
      const key = phase === 'verify'
        ? `reviewer:${call.agentType ?? call.label.split(' · ')[1]?.replace(/\s*\(retry \d+\)$/, '') ?? call.label}`
        : suffix && label.endsWith(suffix) ? label.slice(0, -suffix.length) : label
      const parent = tails.get(key) ?? barrier
      tails.set(key, add(call, parent ? [parent] : [], key))
    } else {
      const parents = gathering ? [...tails.values()] : barrier ? [barrier] : []
      barrier = add(call, parents)
      gathering = false
      tails.clear()
    }
  }
  return nodes
}
