import { useEffect } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { ChevronRight } from 'lucide-react'
import { SpecIcon } from '@/components/icons/SpecIcon'
import { useEditorStore } from '@/stores/editor-store'
import { SPEC_STARTED_EVENT } from './SpecChatBar'
import { SpecStageBadge, useSpecView } from './spec-shared'

/**
 * Where a `start_spec` call sits in the transcript: one line that says a spec
 * started here, and opens it.
 *
 * It used to carry the whole spec — agents, gates, buttons — but a conversation
 * keeps going below it, and the buttons scrolled away just when they were
 * wanted. Those live in the bar above the composer now (`SpecChatBar`); this
 * line is the record, and tells the bar a spec is there.
 */
export function SpecChatCard({ taskId, taskNumber, title }: { taskId: number; taskNumber: number; title: string }) {
  const requestOpenTask = useEditorStore((s) => s.requestOpenTask)
  const projectId = useEditorStore((s) => s.currentProjectId)
  const { spec } = useSpecView(taskId)
  const intl = useIntl()

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(SPEC_STARTED_EVENT, { detail: { taskId } }))
  }, [taskId])

  return (
    <button
      type="button"
      disabled={projectId == null}
      onClick={() => projectId != null && requestOpenTask({ projectId, taskId })}
      title={intl.formatMessage({ id: 'spec.bar.open', defaultMessage: 'Open the spec' })}
      className="group my-2 flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/40 bg-muted/10 px-3 py-2 text-left text-xs transition-colors hover:bg-row-hover disabled:cursor-default"
    >
      <SpecIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">
        <FormattedMessage id="spec.card.started" defaultMessage="Started OperonSpec #{number}" values={{ number: taskNumber }} />
      </span>
      <span className="min-w-0 truncate font-medium text-foreground">{spec?.title ?? title}</span>
      {spec && <SpecStageBadge stage={spec.run.stage} running={spec.running} />}
      <span className="ml-auto flex shrink-0 items-center gap-0.5 text-muted-foreground group-hover:text-foreground">
        <FormattedMessage id="spec.card.open" defaultMessage="Open spec" />
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
    </button>
  )
}
