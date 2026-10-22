import { useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import type { SpecChatRef, SpecView } from '@shared/spec'
import { AgentRow } from '@/components/editor/components/WorkflowRunDetail'
import { AgentTimeline, type TimelineAgent } from './AgentTimeline'
import { buildAgentTimeline } from './agent-timeline-data'
import { SpecAgentList, stageLabel } from './spec-shared'

export function SpecAgentTimeline({ spec, onOpenChat }: { spec: SpecView; onOpenChat?: (chat: SpecChatRef) => void }) {
  const intl = useIntl()
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const runIds = [...new Set(spec.agents.map((agent) => agent.runId))]
  const latestRun = spec.run.workflowRunId ?? runIds.at(-1)
  const runId = selectedRun && runIds.includes(selectedRun) ? selectedRun : runIds.at(-1)
  const timeline = useMemo(() => {
    const records = spec.agents.filter((agent) => agent.runId === runId)
    const live = runId === latestRun && (spec.running || ['grounding', 'designing', 'building', 'reviewing', 'integrating'].includes(spec.run.stage))
    const stoppedAt = runId === latestRun ? spec.run.updatedAt : Math.max(0, ...records.map((agent) => agent.endedAt ?? agent.startedAt ?? 0))
    return buildAgentTimeline(records, live, Date.now(), stoppedAt)
  }, [spec, runId, latestRun])
  if (!timeline) return <SpecAgentList spec={spec} onOpenChat={onOpenChat} />

  const selected = spec.agents.find((agent) => agent.runId === runId && `${agent.runId}:${agent.index}` === selectedAgent)
  const selectAgent = (agent: TimelineAgent) => {
    const record = spec.agents.find((item) => `${item.runId}:${item.index}` === agent.id)
    const chat = record?.chats?.at(-1)
    if (chat && onOpenChat) onOpenChat(chat)
    else setSelectedAgent((previous) => previous === agent.id ? null : agent.id)
  }

  return <div className="min-w-0 space-y-3">
    {runIds.length > 1 && <label className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
      Run
      <select aria-label="Timeline run" value={runId} onChange={(event) => { setSelectedRun(event.target.value); setSelectedAgent(null) }} className="max-w-48 rounded-md border border-border/40 bg-background px-2 py-1 text-foreground">
        {runIds.map((id, index) => <option key={id} value={id}>Run {index + 1}{id === latestRun ? ' · Latest' : ''}</option>)}
      </select>
    </label>}
    <AgentTimeline key={runId} statusLabel={runId === latestRun ? stageLabel(intl, spec.run.stage) : 'Previous run'} {...timeline} onSelectAgent={selectAgent} />
    {timeline.untimed > 0 && <p className="text-xs text-muted-foreground">{timeline.untimed} agent calls have no timing data. See all calls below.</p>}
    {selected && <AgentRow key={`${selected.runId}:${selected.index}`} runId={selected.runId} agent={{ ...selected, chatIds: selected.chats?.map((chat) => chat.chatId) }} stream={undefined} referenceRootPath={selected.chats?.at(-1)?.cwd ?? null} />}
    <SpecAgentList spec={spec} onOpenChat={onOpenChat} />
  </div>
}
