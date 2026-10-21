import { FormattedMessage, useIntl } from 'react-intl'
import { Layers, SquareKanban, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEditorStore } from '@/stores/editor-store'
import { openWorkflowPanel } from '@/components/app-shell/useWorkflowTab'
import {
  SpecActions,
  SpecAgentList,
  SpecBuildSummary,
  SpecGateSummary,
  SpecSeatsLine,
  SpecStageBadge,
  SpecStopButton,
  specHasGate,
  useSpecView,
} from './spec-shared'

/**
 * The card a `start_spec` call leaves in the transcript: where the spec stands,
 * and the design gate right there — the same Approve / Request changes as the
 * task page, so the user never has to leave the conversation to sign it.
 */
export function SpecChatCard({ taskId, taskNumber, title }: { taskId: number; taskNumber: number; title: string }) {
  const requestOpenTask = useEditorStore((s) => s.requestOpenTask)
  const projectId = useEditorStore((s) => s.currentProjectId)
  const { spec, error } = useSpecView(taskId)
  const intl = useIntl()
  const openTask = () => projectId != null && requestOpenTask({ projectId, taskId })
  const boardLabel = intl.formatMessage({ id: 'spec.card.openBoard', defaultMessage: 'Open on the board' })

  return (
    <div className="@container my-2 rounded-xl border border-border/50 bg-background/60 shadow-card">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/40">
          <Layers className="h-4 w-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            OperonSpec
            <span className="font-mono normal-case tracking-normal">#{taskNumber}</span>
            {spec && <SpecStageBadge stage={spec.run.stage} running={spec.running} />}
          </div>
          {/* The title is the task: clicking it opens the board card, like the button. */}
          <button
            type="button"
            disabled={projectId == null}
            onClick={openTask}
            title={boardLabel}
            className="mt-0.5 block max-w-full cursor-pointer truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline"
          >
            {spec?.title ?? title}
          </button>
          {spec && <SpecSeatsLine spec={spec} />}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Stop sits with the other controls: a row of its own under the card
              made a running spec's card a good deal taller for one button. */}
          {spec?.running && <SpecStopButton spec={spec} />}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            onClick={() => openWorkflowPanel()}
          >
            <Workflow className="h-3.5 w-3.5" />
            {/* A narrow chat column gives the title the room; the icons stay. */}
            <span className="@max-[480px]:sr-only">
              <FormattedMessage id="spec.card.watch" defaultMessage="Agents" />
            </span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            disabled={projectId == null}
            onClick={openTask}
            title={boardLabel}
          >
            {/* A board icon and a label that stays: an arrow alone did not say
                where it went. */}
            <SquareKanban className="h-3.5 w-3.5" />
            <FormattedMessage id="spec.card.board" defaultMessage="Board" />
          </Button>
        </div>
      </div>
      {spec && spec.agents.length > 0 && (
        <div className="border-t border-border/40 px-3 py-2">
          <SpecAgentList spec={spec} />
        </div>
      )}
      {spec && specHasGate(spec) && (
        <div className="space-y-2 border-t border-border/40 px-3 py-2.5">
          <SpecGateSummary spec={spec} />
          <SpecActions spec={spec} showStop={false} />
        </div>
      )}
      {spec && spec.run.build.length > 0 && (
        <div className="border-t border-border/40 px-3 py-2">
          <SpecBuildSummary spec={spec} />
        </div>
      )}
      {error && !spec && <div className="border-t border-border/40 px-3 py-2 text-xs text-destructive">{error}</div>}
    </div>
  )
}
