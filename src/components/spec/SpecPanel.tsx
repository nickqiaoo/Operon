import { type ReactNode } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Layers, Loader2 } from 'lucide-react'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useTaskStore } from '@/stores/task-store'
import { StatusIcon } from '@/components/task/task-meta'
import type { SpecReviewSummary, SpecStage, SpecView } from '@shared/spec'
import {
  SPEC_MARKDOWN_CLASS,
  SpecActions,
  SpecAgentList,
  SpecBuildSummary,
  SpecSeatsLine,
  SpecStageBadge,
  TicketBuildLine,
  useSpecView,
} from './spec-shared'

/** Underline tabs: the bottom rule already separates the strip, so it carries no fill. */
const TAB_TRIGGER = cn(
  'relative h-8 flex-none gap-1.5 rounded-none border-0 bg-transparent px-0.5 text-xs font-medium',
  'text-muted-foreground transition-colors hover:text-foreground',
  'data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none',
  'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full',
  'after:bg-transparent data-[state=active]:after:bg-foreground/80',
  'disabled:opacity-45',
)

/**
 * The spec on its task page: stage, the design gate, and everything the agents
 * produced — the design first, then how it was reached.
 */
export function SpecPanel({
  taskId,
  stage,
  onOpenWorkspace,
}: {
  taskId: number
  stage: SpecStage | null
  /** Opens a ticket's worktree and its session; absent where the page cannot navigate. */
  onOpenWorkspace?: (workspaceId: number) => void
}) {
  const { spec, error } = useSpecView(taskId, stage)

  if (!spec) {
    return (
      <section className="border-y border-border/40 py-5">
        {error ? (
          <div className="text-xs text-destructive">{error}</div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="space-y-4 border-y border-border/40 py-5">
      <div className="flex items-start gap-3 px-0.5">
        <Layers className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">OperonSpec</span>
            <SpecStageBadge stage={spec.run.stage} running={spec.running} />
          </div>
          <SpecSeatsLine spec={spec} />
          <SpecBuildSummary spec={spec} />
        </div>
      </div>

      <SpecAgentList spec={spec} />

      <SpecActions spec={spec} />

      <SpecTabs spec={spec} onOpenWorkspace={onOpenWorkspace} />
    </section>
  )
}

function SpecTabs({ spec, onOpenWorkspace }: { spec: SpecView; onOpenWorkspace?: (workspaceId: number) => void }) {
  const intl = useIntl()
  const builds = new Map(spec.run.build.map((b) => [b.key, b]))
  // Once the tickets are being built, where they stand is what the page is for.
  const first = spec.review
    ? 'review'
    : spec.run.build.length > 0
      ? 'tickets'
      : spec.design
        ? 'design'
        : spec.candidates.length > 0
          ? 'candidates'
          : 'brief'
  return (
    <Tabs defaultValue={first} key={first} className="gap-3">
      <TabsList className="h-8 w-full justify-start gap-5 rounded-none border-0 border-b border-border/40 bg-transparent p-0">
        <TabsTrigger value="design" disabled={!spec.design} className={TAB_TRIGGER}>
          <FormattedMessage id="spec.tab.design" defaultMessage="Design" />
        </TabsTrigger>
        <TabsTrigger value="candidates" disabled={spec.candidates.length === 0} className={TAB_TRIGGER}>
          <FormattedMessage id="spec.tab.candidates" defaultMessage="Candidates" />
          {spec.candidates.length > 0 && (
            <span className="text-[10px] font-normal text-muted-foreground/70">{spec.candidates.length}</span>
          )}
        </TabsTrigger>
        <TabsTrigger value="tickets" disabled={!spec.tickets} className={TAB_TRIGGER}>
          <FormattedMessage id="spec.tab.tickets" defaultMessage="Tickets" />
          {spec.tickets && <span className="text-[10px] font-normal text-muted-foreground/70">{spec.tickets.length}</span>}
        </TabsTrigger>
        <TabsTrigger value="review" disabled={!spec.review} className={TAB_TRIGGER}>
          <FormattedMessage id="spec.tab.review" defaultMessage="Review" />
        </TabsTrigger>
        <TabsTrigger value="brief" className={TAB_TRIGGER}>
          <FormattedMessage id="spec.tab.brief" defaultMessage="Brief" />
        </TabsTrigger>
      </TabsList>

      <TabsContent value="design" className="space-y-3">
        {spec.design && <Doc content={spec.design} />}
        {spec.synthesis && (
          <Doc
            title={intl.formatMessage({ id: 'spec.doc.synthesis', defaultMessage: 'How the design was reached' })}
            content={spec.synthesis}
          />
        )}
      </TabsContent>

      <TabsContent value="candidates" className="space-y-3">
        {spec.judge && (
          <Doc title={intl.formatMessage({ id: 'spec.doc.judge', defaultMessage: 'Judge' })} content={spec.judge} />
        )}
        {spec.candidates.map((c) => (
          <Doc
            key={c.key}
            title={intl.formatMessage(
              { id: 'spec.doc.candidate', defaultMessage: 'Candidate {key} · {provider}' },
              { key: c.key, provider: c.providerId },
            )}
            content={c.content}
            collapsed
          />
        ))}
      </TabsContent>

      <TabsContent value="tickets" className="space-y-3">
        {spec.tickets && (
          <ol className="space-y-2">
            {spec.tickets.map((t) => (
              <li key={t.key} className="rounded-lg border border-border/40 bg-background/40 px-3 py-2.5">
                <div className="flex items-baseline gap-2">
                  <TicketRef spec={spec} ticketKey={t.key} />
                  <span className="text-sm font-medium">{t.title}</span>
                  {t.blockedBy.length > 0 && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      <FormattedMessage
                        id="spec.ticket.blockedBy"
                        defaultMessage="after {keys}"
                        values={{
                          keys: t.blockedBy.map((k) => (spec.ticketTasks[k] ? `#${spec.ticketTasks[k].number}` : k)).join(', '),
                        }}
                      />
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{t.delivers}</div>
                <ul className="mt-1.5 space-y-0.5 text-xs text-foreground/80">
                  {t.acceptance.map((a, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-muted-foreground">–</span>
                      {a}
                    </li>
                  ))}
                </ul>
                {builds.get(t.key) && (
                  <TicketBuildLine
                    build={builds.get(t.key)!}
                    onOpenSession={
                      onOpenWorkspace && spec.ticketTasks[t.key]?.workspaceId != null
                        ? () => onOpenWorkspace(spec.ticketTasks[t.key].workspaceId!)
                        : undefined
                    }
                  />
                )}
              </li>
            ))}
          </ol>
        )}
        {spec.run.rulings.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-border/40 bg-background/40 px-3 py-2.5">
            <div className="heading-section">
              <FormattedMessage id="spec.rulings.title" defaultMessage="Calls the builders made" />
            </div>
            <ul className="space-y-1 text-xs text-foreground/80">
              {spec.run.rulings.map((r, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 font-mono text-muted-foreground">{r.ticketKey}</span>
                  <span>{r.ruling}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </TabsContent>

      <TabsContent value="review" className="space-y-3">
        {spec.reviewSummary && <ReviewCounts summary={spec.reviewSummary} />}
        {spec.review && <Doc content={spec.review} />}
      </TabsContent>

      <TabsContent value="brief" className="space-y-3">
        {spec.brief && <Doc title={intl.formatMessage({ id: 'spec.doc.brief', defaultMessage: 'Brief' })} content={spec.brief} />}
        {spec.feedback && (
          <Doc title={intl.formatMessage({ id: 'spec.doc.feedback', defaultMessage: 'Your feedback' })} content={spec.feedback} />
        )}
        {spec.grounding && (
          <Doc
            title={intl.formatMessage({ id: 'spec.doc.grounding', defaultMessage: 'How the code works today' })}
            content={spec.grounding}
            collapsed
          />
        )}
      </TabsContent>
    </Tabs>
  )
}

/** Gate 2 at a glance: what is left to act on, and how many criteria were actually shown to pass. */
function ReviewCounts({ summary }: { summary: SpecReviewSummary }) {
  const cells: { value: number; label: ReactNode; tone?: string }[] = [
    {
      value: summary.actOn,
      label: <FormattedMessage id="spec.review.actOn" defaultMessage="Act on" />,
      tone: summary.actOn > 0 ? 'text-status-error' : undefined,
    },
    { value: summary.consider, label: <FormattedMessage id="spec.review.consider" defaultMessage="Consider" /> },
    { value: summary.noted, label: <FormattedMessage id="spec.review.noted" defaultMessage="Noted" /> },
    { value: summary.dismissed, label: <FormattedMessage id="spec.review.dismissed" defaultMessage="Dismissed" /> },
    {
      value: summary.pass,
      label: <FormattedMessage id="spec.review.pass" defaultMessage="Criteria passed" />,
      tone: 'text-status-ok',
    },
    {
      value: summary.fail,
      label: <FormattedMessage id="spec.review.fail" defaultMessage="Failed" />,
      tone: summary.fail > 0 ? 'text-status-error' : undefined,
    },
    {
      value: summary.notRun,
      label: <FormattedMessage id="spec.review.notRun" defaultMessage="Not verified" />,
      tone: summary.notRun > 0 ? 'text-status-warn' : undefined,
    },
  ]
  return (
    <div className="grid grid-cols-4 gap-2 rounded-lg border border-border/40 bg-background/40 p-3 sm:grid-cols-7">
      {cells.map((c, i) => (
        <div key={i} className="min-w-0">
          <div className={cn('text-base font-semibold tabular-nums', c.tone ?? 'text-foreground')}>{c.value}</div>
          <div className="truncate text-[11px] text-muted-foreground">{c.label}</div>
        </div>
      ))}
    </div>
  )
}

function Doc({ title, content, collapsed }: { title?: ReactNode; content: string; collapsed?: boolean }) {
  const body = (
    <div className="px-4 py-4">
      <MarkdownRenderer content={content} className={SPEC_MARKDOWN_CLASS} />
    </div>
  )
  if (!title) {
    return <article className="overflow-hidden rounded-xl border border-border/40 bg-background/55">{body}</article>
  }
  return (
    <details
      open={!collapsed}
      className="group overflow-hidden rounded-xl border border-border/40 bg-background/55"
    >
      <summary className="cursor-pointer select-none border-b border-transparent px-4 py-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground group-open:border-border/40">
        {title}
      </summary>
      {body}
    </details>
  )
}

/** A ticket's key until approval; afterwards the board task it became, with its status, one click away. */
function TicketRef({ spec, ticketKey }: { spec: SpecView; ticketKey: string }) {
  const openDetail = useTaskStore((s) => s.openDetail)
  const task = spec.ticketTasks[ticketKey]
  if (!task) return <span className="font-mono text-xs text-muted-foreground">{ticketKey}</span>
  return (
    <button
      type="button"
      onClick={() => void openDetail(task.id)}
      className="inline-flex shrink-0 items-center gap-1 self-center rounded-md px-1 text-xs tabular-nums text-muted-foreground hover:bg-row-hover hover:text-foreground"
    >
      <StatusIcon status={task.status} />#{task.number}
    </button>
  )
}
