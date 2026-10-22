import type { SpecAgentRun } from '@shared/spec'
import type { OrchestratorSegment, TimelineAgent } from './AgentTimeline'
import { fileCitationsToText } from '@/lib/file-citation'

const COLORS = ['#4daaff', '#ac35d0', '#f58200', '#00b978', '#ef638b', '#36c7d0']

/** One run uses its own clock, so approval gaps between runs do not flatten it. */
export function buildAgentTimeline(records: SpecAgentRun[], live: boolean, now: number, stoppedAt: number) {
  const timed = records.filter((agent) => agent.startedAt != null && Number.isFinite(agent.startedAt))
  if (timed.length === 0) return null
  const origin = Math.min(...timed.map((agent) => agent.startedAt!))
  const agents: TimelineAgent[] = timed.map((agent, index) => {
    const running = live && agent.state === 'running' && agent.endedAt == null
    const start = Math.max(0, (agent.startedAt! - origin) / 1000)
    const end = running ? undefined : Math.max(start, ((agent.endedAt ?? (agent.state === 'running' ? stoppedAt : agent.startedAt!)) - origin) / 1000)
    const provider = agent.agentType ?? agent.chats?.at(-1)?.providerId ?? ''
    const label = fileCitationsToText(agent.label)
    const suffix = ` · ${provider}`
    return {
      id: `${agent.runId}:${agent.index}`,
      role: provider && label.endsWith(suffix) ? label.slice(0, -suffix.length) : label,
      model: agent.modelId ?? (provider || 'Model not recorded'),
      provider,
      color: COLORS[index % COLORS.length],
      start,
      end,
      status: running ? 'running' : agent.state === 'error' ? 'failed' : agent.state === 'done' ? 'done' : 'stopped',
    }
  })
  const running = agents.some((agent) => agent.status === 'running')
  const elapsed = Math.max(0, ...agents.map((agent) => agent.end ?? Math.max(agent.start, (now - origin) / 1000)))
  // Union of recorded activity intervals. Gaps are workflow intervals, not
  // invented coordinator model calls or inferred agent-to-agent dependencies.
  const intervals = agents.map((agent) => ({ start: agent.start, end: agent.end ?? Infinity })).sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const interval of intervals) {
    const previous = merged.at(-1)
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end)
    else merged.push({ ...interval })
  }
  const orchestrator: OrchestratorSegment[] = []
  let cursor = 0
  for (const interval of merged) {
    if (interval.start > cursor) orchestrator.push({ start: cursor, end: interval.start, state: 'working' })
    orchestrator.push({ ...interval, state: 'delegating' })
    cursor = interval.end
  }
  return { agents, orchestrator, elapsed, running, untimed: records.length - timed.length }
}
