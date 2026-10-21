import { useCallback, useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { ChevronDown, Layers, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import { openWorkflowPanel } from '@/components/app-shell/useWorkflowTab'
import type { SpecStage } from '@shared/spec'
import {
  SpecActions,
  SpecAgentList,
  SpecBuildSummary,
  SpecGateSummary,
  SpecStageBadge,
  SpecStopButton,
  specHasGate,
  useSpecView,
} from './spec-shared'

/** Fired when a spec card shows up in a conversation, so its bar picks the new spec up at once. */
export const SPEC_STARTED_EVENT = 'operon:spec-started'

/** Between events a spec can still start from elsewhere (another window, the phone). */
const LIST_POLL_MS = 15_000

interface ChatSpec {
  taskId: number
  taskNumber: number
  title: string
  stage: SpecStage
}

/**
 * The specs a conversation started, held above its composer while they run.
 *
 * The spec's card stays where `start_spec` left it, and a conversation keeps
 * going below it — every stage reports back, the user replies — so the card
 * scrolled away just when its buttons were wanted. The bar is where the user
 * already is: one line while the spec runs, and the gate's buttons right there
 * when it needs them (approve, sign off, a switch the coordinator asks for).
 * Several specs show the newest, with a way to step through the others.
 */
export function SpecChatBar({ chatId }: { chatId?: number | null }) {
  const [specs, setSpecs] = useState<ChatSpec[]>([])
  const [selected, setSelected] = useState(0)

  const load = useCallback(async () => {
    if (chatId == null || chatId <= 0) return setSpecs([])
    try {
      const { specs } = await api.specListByChat(chatId)
      setSpecs(specs)
    } catch {
      // Keep what is shown; the next poll tries again.
    }
  }, [chatId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), LIST_POLL_MS)
    const onStarted = () => void load()
    window.addEventListener(SPEC_STARTED_EVENT, onStarted)
    return () => {
      clearInterval(timer)
      window.removeEventListener(SPEC_STARTED_EVENT, onStarted)
    }
  }, [load])

  if (specs.length === 0) return null
  const index = Math.min(selected, specs.length - 1)
  const current = specs[index]
  return (
    <SpecBar
      key={current.taskId}
      spec={current}
      others={specs.length - 1}
      onNext={() => setSelected((index + 1) % specs.length)}
      onDone={() => void load()}
    />
  )
}

function SpecBar({ spec: entry, others, onNext, onDone }: { spec: ChatSpec; others: number; onNext: () => void; onDone: () => void }) {
  const intl = useIntl()
  const { spec } = useSpecView(entry.taskId, entry.stage)
  const requestOpenTask = useEditorStore((s) => s.requestOpenTask)
  const projectId = useEditorStore((s) => s.currentProjectId)
  const [expanded, setExpanded] = useState(false)
  const stage = spec?.run.stage ?? entry.stage
  const done = stage === 'done'
  useEffect(() => {
    if (done) onDone()
  }, [done, onDone])
  if (done) return null

  const needsYou = spec != null && specHasGate(spec)
  const progress = spec && spec.run.build.length > 0 ? `${spec.run.build.filter((b) => b.state === 'merged').length}/${spec.run.build.length}` : null
  const openSpec = () => projectId != null && requestOpenTask({ projectId, taskId: entry.taskId })

  return (
    <div
      className={cn(
        '@container mb-2 overflow-hidden rounded-xl border bg-background/80 shadow-card',
        needsYou ? 'border-status-warn/40' : 'border-border/50',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Layers className={cn('h-4 w-4 shrink-0', needsYou ? 'text-status-warn' : 'text-muted-foreground')} />
        <button
          type="button"
          onClick={openSpec}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
          title={intl.formatMessage({ id: 'spec.bar.open', defaultMessage: 'Open the spec' })}
        >
          <span className="shrink-0 font-mono text-muted-foreground">#{entry.taskNumber}</span>
          <span className="min-w-0 truncate font-medium text-foreground">{spec?.title ?? entry.title}</span>
          <SpecStageBadge stage={stage} running={spec?.running} />
          {progress && <span className="shrink-0 tabular-nums text-muted-foreground">{progress}</span>}
        </button>
        {others > 0 && (
          <button type="button" onClick={onNext} className="shrink-0 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-row-hover hover:text-foreground">
            <FormattedMessage id="spec.bar.others" defaultMessage="+{count} more" values={{ count: others }} />
          </button>
        )}
        {spec?.running && <SpecStopButton spec={spec} />}
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" onClick={() => openWorkflowPanel()}>
          <Workflow className="h-3.5 w-3.5" />
          <span className="@max-[480px]:sr-only">
            <FormattedMessage id="spec.card.watch" defaultMessage="Workflow" />
          </span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={intl.formatMessage({ id: 'spec.bar.details', defaultMessage: 'Details' })}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
        </Button>
      </div>
      {/* What it waits on is shown without asking: that is what the bar is for. */}
      {spec && needsYou && (
        <div className="scroll-fade-y max-h-72 space-y-2 overflow-y-auto border-t border-border/40 px-3 py-2">
          <SpecGateSummary spec={spec} />
          <SpecActions spec={spec} showStop={false} />
        </div>
      )}
      {spec && expanded && (
        <div className="scroll-fade-y max-h-72 space-y-2 overflow-y-auto border-t border-border/40 px-3 py-2">
          {spec.agents.length > 0 && <SpecAgentList spec={spec} />}
          {spec.run.build.length > 0 && <SpecBuildSummary spec={spec} />}
          {!needsYou && <SpecActions spec={spec} showStop={false} />}
        </div>
      )}
    </div>
  )
}
