import { type ReactNode } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { AlertCircle, Layers, Loader2, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useTaskStore } from '@/stores/task-store'
import { StatusIcon, relativeTime } from '@/components/task/task-meta'
import type { SpecAdr, SpecChatRef, SpecDecisions, SpecReviewSummary, SpecStage, SpecTicketTask, SpecView } from '@shared/spec'
import {
  SPEC_MARKDOWN_CLASS,
  SpecActions,
  SpecAgentList,
  SpecBuildSummary,
  SpecCoordinatorLine,
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
  onOpenChat,
}: {
  taskId: number
  stage: SpecStage | null
  /** Opens a ticket's worktree; absent where the page cannot navigate. */
  onOpenWorkspace?: (workspaceId: number) => void
  /** Opens one of the spec's conversations; absent where the page cannot navigate. */
  onOpenChat?: (chat: SpecChatRef) => void
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
        {/* The one conversation about the spec: what needs the user lands there, and it is where they answer. */}
        {spec.sourceChat && onOpenChat && (
          <Button size="sm" variant="secondary" className="h-8 shrink-0 gap-1.5" onClick={() => onOpenChat(spec.sourceChat!)}>
            <MessageSquareText className="h-3.5 w-3.5" />
            <FormattedMessage id="spec.panel.openChat" defaultMessage="Open chat" />
          </Button>
        )}
      </div>

      <SpecCoordinatorLine spec={spec} onOpenChat={onOpenChat} />

      <SpecAgentList spec={spec} onOpenChat={onOpenChat} />

      <SpecActions spec={spec} />

      <SpecTabs spec={spec} onOpenWorkspace={onOpenWorkspace} onOpenChat={onOpenChat} />
    </section>
  )
}

/**
 * Where "open its session" goes: the ticket's latest chat, which outlives the
 * ticket's worktree; for a ticket without one on record, its worktree.
 */
function ticketSessionOpener(
  task: SpecTicketTask | undefined,
  onOpenChat?: (chat: SpecChatRef) => void,
  onOpenWorkspace?: (workspaceId: number) => void,
): (() => void) | undefined {
  const chat = task?.chats.at(-1)
  if (chat && onOpenChat) return () => onOpenChat(chat)
  if (task?.workspaceId != null && onOpenWorkspace) return () => onOpenWorkspace(task.workspaceId!)
  return undefined
}

function SpecTabs({
  spec,
  onOpenWorkspace,
  onOpenChat,
}: {
  spec: SpecView
  onOpenWorkspace?: (workspaceId: number) => void
  onOpenChat?: (chat: SpecChatRef) => void
}) {
  const intl = useIntl()
  const builds = new Map(spec.run.build.map((b) => [b.key, b]))
  const sessionCount = countSessions(spec)
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
      {/* Seven tabs outgrow a phone: the strip scrolls sideways instead of clipping the last one. */}
      <TabsList className="h-8 w-full justify-start gap-5 overflow-x-auto overflow-y-hidden rounded-none border-0 border-b border-border/40 bg-transparent p-0 scrollbar-none">
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
        <TabsTrigger value="decisions" disabled={!spec.decisions} className={TAB_TRIGGER}>
          <FormattedMessage id="spec.tab.decisions" defaultMessage="Decisions" />
          {spec.decisions && (
            <span className="text-[10px] font-normal text-muted-foreground/70">
              {spec.decisions.adrs.length + spec.decisions.glossary.length}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="sessions" disabled={sessionCount === 0} className={TAB_TRIGGER}>
          <FormattedMessage id="spec.tab.sessions" defaultMessage="Sessions" />
          {sessionCount > 0 && <span className="text-[10px] font-normal text-muted-foreground/70">{sessionCount}</span>}
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
                    spec={spec}
                    onOpenSession={ticketSessionOpener(spec.ticketTasks[t.key], onOpenChat, onOpenWorkspace)}
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

      <TabsContent value="decisions" className="space-y-3">
        {spec.decisions && <Decisions decisions={spec.decisions} />}
      </TabsContent>

      <TabsContent value="sessions" className="space-y-3">
        <Sessions spec={spec} onOpenChat={onOpenChat} />
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

function countSessions(spec: SpecView): number {
  return (
    (spec.sourceChat ? 1 : 0) +
    (spec.coordinator?.chat ? 1 : 0) +
    spec.agents.reduce((n, a) => n + (a.chats?.length ?? 0), 0) +
    Object.values(spec.ticketTasks).reduce((n, t) => n + t.chats.length, 0)
  )
}

/**
 * Every conversation the spec has had, by where it came from: the chat it was
 * started in, each agent its runs dispatched (design roles, ticket reviews,
 * the final review), and each ticket's builder. All of them are ordinary chats
 * and open as such — read them, or pick one up where it left off.
 */
function Sessions({ spec, onOpenChat }: { spec: SpecView; onOpenChat?: (chat: SpecChatRef) => void }) {
  // Agents by the phase they ran in, in the order they started.
  const phases: { title: string; rows: { key: string; label: string; state: string; chat: SpecChatRef }[] }[] = []
  let earlier = 0
  for (const agent of spec.agents) {
    if (!agent.chats?.length) {
      earlier++
      continue
    }
    const title = agent.phase ?? ''
    let group = phases.at(-1)
    if (!group || group.title !== title) phases.push((group = { title, rows: [] }))
    // A handoff ran the agent in a second chat, named for its provider.
    for (const chat of agent.chats) {
      group.rows.push({ key: `${agent.runId}:${agent.index}:${chat.chatId}`, label: chat.title, state: agent.state, chat })
    }
  }
  const tickets = (spec.tickets ?? []).filter((t) => (spec.ticketTasks[t.key]?.chats.length ?? 0) > 0)
  return (
    <div className="space-y-4">
      {spec.sourceChat && (
        <SessionGroup title={<FormattedMessage id="spec.sessions.source" defaultMessage="The spec's chat" />}>
          <SessionRow chat={spec.sourceChat} label={spec.sourceChat.title} onOpenChat={onOpenChat} />
        </SessionGroup>
      )}
      {spec.coordinator?.chat && (
        <SessionGroup title={<FormattedMessage id="spec.sessions.coordinator" defaultMessage="Coordinator · working log" />}>
          <SessionRow
            chat={spec.coordinator.chat}
            label={spec.coordinator.chat.title}
            state={spec.coordinator.status === 'active' ? 'running' : undefined}
            onOpenChat={onOpenChat}
          />
        </SessionGroup>
      )}
      {phases.map((group, i) => (
        <SessionGroup
          key={`${group.title}:${i}`}
          title={group.title || <FormattedMessage id="spec.sessions.agents" defaultMessage="Agents" />}
        >
          {group.rows.map((row) => (
            <SessionRow key={row.key} chat={row.chat} label={row.label} state={row.state} onOpenChat={onOpenChat} />
          ))}
        </SessionGroup>
      ))}
      {tickets.length > 0 && (
        <SessionGroup title={<FormattedMessage id="spec.sessions.tickets" defaultMessage="Ticket builders" />}>
          {tickets.map((t) =>
            spec.ticketTasks[t.key].chats.map((chat) => (
              <SessionRow
                key={`${t.key}:${chat.chatId}`}
                chat={chat}
                label={`${t.key} · ${t.title}`}
                onOpenChat={onOpenChat}
              />
            )),
          )}
        </SessionGroup>
      )}
      {earlier > 0 && (
        <p className="px-0.5 text-xs leading-5 text-muted-foreground">
          <FormattedMessage
            id="spec.sessions.earlier"
            defaultMessage="{count, plural, one {# agent call} other {# agent calls}} ran before agents were kept as conversations; their output is in the agent list above."
            values={{ count: earlier }}
          />
        </p>
      )}
    </div>
  )
}

function SessionGroup({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="heading-section px-1">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function SessionRow({
  chat,
  label,
  state,
  onOpenChat,
}: {
  chat: SpecChatRef
  label: string
  /** An agent's state, when the row is one. */
  state?: string
  onOpenChat?: (chat: SpecChatRef) => void
}) {
  const body = (
    <>
      <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {state === 'running' && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-status-info" />}
      {state === 'error' && <AlertCircle className="h-3 w-3 shrink-0 text-status-error" />}
      {chat.providerId && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{chat.providerId}</span>}
      <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70">{relativeTime(chat.updatedAt)}</span>
    </>
  )
  const className = 'flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs'
  if (!onOpenChat) return <div className={className}>{body}</div>
  return (
    <button
      type="button"
      onClick={() => onOpenChat(chat)}
      className={cn(className, 'transition-colors hover:bg-row-hover')}
      title={chat.title}
    >
      {body}
    </button>
  )
}

/**
 * What the change leaves behind: its ADRs and glossary terms — proposed until
 * gate 2 is signed, then the files that were written.
 */
function Decisions({ decisions }: { decisions: SpecDecisions }) {
  const intl = useIntl()
  const empty = decisions.adrs.length === 0 && decisions.glossary.length === 0
  return (
    <>
      <p className="px-0.5 text-xs leading-5 text-muted-foreground">
        {empty ? (
          <FormattedMessage id="spec.decisions.none" defaultMessage="This change records no new decisions or terms." />
        ) : decisions.recorded ? (
          <FormattedMessage
            id="spec.decisions.recorded"
            defaultMessage="Written into the repository at sign-off: {files}"
            values={{ files: decisions.recorded.files.join(', ') }}
          />
        ) : (
          <FormattedMessage
            id="spec.decisions.pending"
            defaultMessage="Signing off writes these to docs/adr/ and GLOSSARY.md; ADR numbers are assigned then."
          />
        )}
      </p>
      {decisions.adrs.map((adr) => (
        <Doc
          key={adr.slug}
          title={
            adr.number != null
              ? intl.formatMessage(
                  { id: 'spec.decisions.adrNumbered', defaultMessage: 'ADR {number} · {title}' },
                  { number: String(adr.number).padStart(4, '0'), title: adr.title },
                )
              : intl.formatMessage({ id: 'spec.decisions.adr', defaultMessage: 'ADR · {title}' }, { title: adr.title })
          }
          content={adrBody(
            adr,
            adr.supersedes != null
              ? intl.formatMessage(
                  { id: 'spec.decisions.supersedes', defaultMessage: 'Supersedes ADR {number}' },
                  { number: String(adr.supersedes).padStart(4, '0') },
                )
              : null,
          )}
        />
      ))}
      {decisions.glossary.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-border/40 bg-background/40 px-3 py-2.5">
          <div className="heading-section">
            <FormattedMessage id="spec.decisions.glossary" defaultMessage="Glossary terms" />
          </div>
          <dl className="space-y-1.5 text-xs">
            {decisions.glossary.map((g) => (
              <div key={g.term}>
                <dt className="font-medium text-foreground">{g.term}</dt>
                <dd className="leading-5 text-muted-foreground">{g.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  )
}

/** An ADR's sections, as its file has them (the file's title is the card's). */
function adrBody(adr: SpecAdr, supersedes: string | null): string {
  return [
    supersedes ? `_${supersedes}_` : '',
    `## Context\n${adr.context}`,
    `## Decision\n${adr.decision}`,
    `## Consequences\n${adr.consequences}`,
  ]
    .filter(Boolean)
    .join('\n\n')
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
