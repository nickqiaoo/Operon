import { fileCitationsToText } from '@/lib/file-citation'
import { cloneElement, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl'
import { AlertCircle, ArrowLeftRight, Bot, Check, ChevronRight, Clock, ExternalLink, GitMerge, Hammer, Loader2, MessageSquareText, Play, Send, Square, X } from 'lucide-react'
import { ProviderLabel } from '@/components/icons/ProviderLabel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { MobileSheet } from '@/components/mobile/MobileSheet'
import { useIsMobile } from '@/hooks/useIsMobile'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AgentRow, formatDuration } from '@/components/editor/components/WorkflowRunDetail'
import type { SpecChatRef, SpecRole, SpecSeat, SpecSeatView, SpecStage, SpecSwitch, SpecTicketBuild, SpecTicketState, SpecView } from '@shared/spec'
import { SeatPicker, seatName } from './SeatPicker'
import type { TaskListItem } from '@/types/task'

/** Stages in which the server is working and the view changes on its own. */
const LIVE_STAGES: readonly SpecStage[] = ['grounding', 'designing', 'reviewing']
const POLL_MS = 2500
/** Building lasts hours and moves when a ticket does — fast enough to see a review land. */
const BUILD_POLL_MS = 5000
/**
 * Between runs a spec still changes from elsewhere — the chat agent answering its
 * questions, another window resuming it, a ticket editing the signed design — so
 * an idle view checks in now and then instead of never.
 */
const IDLE_POLL_MS = 15_000

/** Every mounted view of a spec, so an action on one (chat card, task page) reloads the others. */
const specViewers = new Map<number, Set<() => void>>()

export function notifySpecChanged(taskId: number): void {
  for (const reload of specViewers.get(taskId) ?? []) reload()
}

/**
 * The spec behind a task, kept fresh while its design is running.
 *
 * Polls quickly while the design runs and slowly otherwise. Actions taken here reload every
 * view of the same spec; `stage` is the task's own `specStage` where the caller
 * has it, so a change made elsewhere (an agent, another device) reloads too.
 */
export function useSpecView(taskId: number, stage?: SpecStage | null) {
  const [spec, setSpec] = useState<SpecView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const reload = useCallback(async () => {
    try {
      const { spec } = await api.specGet(taskId)
      if (!alive.current) return
      setSpec(spec)
      setError(null)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [taskId])

  useEffect(() => {
    alive.current = true
    void reload()
    return () => {
      alive.current = false
    }
  }, [reload, stage])

  useEffect(() => {
    let viewers = specViewers.get(taskId)
    if (!viewers) specViewers.set(taskId, (viewers = new Set()))
    const listener = () => void reload()
    viewers.add(listener)
    return () => {
      viewers.delete(listener)
      if (viewers.size === 0) specViewers.delete(taskId)
    }
  }, [taskId, reload])

  const pollMs =
    spec != null && (spec.running || LIVE_STAGES.includes(spec.run.stage))
      ? POLL_MS
      : spec?.run.stage === 'building' || spec?.run.stage === 'integrating'
        ? BUILD_POLL_MS
        : IDLE_POLL_MS
  useEffect(() => {
    const timer = setInterval(() => void reload(), pollMs)
    return () => clearInterval(timer)
  }, [pollMs, reload])

  return { spec, error }
}

export function stageLabel(intl: IntlShape, stage: SpecStage): string {
  switch (stage) {
    case 'grounding':
      return intl.formatMessage({ id: 'spec.stage.grounding', defaultMessage: 'Mapping the code' })
    case 'designing':
      return intl.formatMessage({ id: 'spec.stage.designing', defaultMessage: 'Designing' })
    case 'awaiting_answers':
      return intl.formatMessage({ id: 'spec.stage.awaitingAnswers', defaultMessage: 'Needs your answers' })
    case 'awaiting_design':
      return intl.formatMessage({ id: 'spec.stage.awaitingDesign', defaultMessage: 'Awaiting approval' })
    case 'building':
      return intl.formatMessage({ id: 'spec.stage.building', defaultMessage: 'Building' })
    case 'reviewing':
      return intl.formatMessage({ id: 'spec.stage.reviewing', defaultMessage: 'Reviewing the change' })
    case 'awaiting_signoff':
      return intl.formatMessage({ id: 'spec.stage.awaitingSignoff', defaultMessage: 'Awaiting sign-off' })
    case 'integrating':
      return intl.formatMessage({ id: 'spec.stage.integrating', defaultMessage: 'Resolving a merge conflict' })
    case 'done':
      return intl.formatMessage({ id: 'spec.stage.done', defaultMessage: 'Done' })
    case 'stopped':
      return intl.formatMessage({ id: 'spec.stage.stopped', defaultMessage: 'Stopped' })
    case 'failed':
      return intl.formatMessage({ id: 'spec.stage.failed', defaultMessage: 'Failed' })
  }
}

const STAGE_TONE: Record<SpecStage, string> = {
  grounding: 'bg-status-info/10 text-status-info',
  designing: 'bg-status-info/10 text-status-info',
  awaiting_answers: 'bg-status-warn/10 text-status-warn',
  awaiting_design: 'bg-status-warn/10 text-status-warn',
  building: 'bg-status-info/10 text-status-info',
  reviewing: 'bg-status-info/10 text-status-info',
  awaiting_signoff: 'bg-status-warn/10 text-status-warn',
  integrating: 'bg-status-info/10 text-status-info',
  done: 'bg-status-ok/10 text-status-ok',
  stopped: 'bg-muted text-muted-foreground',
  failed: 'bg-status-error/10 text-status-error',
}

export function SpecStageBadge({ stage, running }: { stage: SpecStage; running?: boolean }) {
  const intl = useIntl()
  const busy = running || LIVE_STAGES.includes(stage)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        STAGE_TONE[stage],
      )}
    >
      {busy && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />}
      {stageLabel(intl, stage)}
    </span>
  )
}

/** Who plays which part, in one line: "claude-code, codex · judge grok". */
export function SpecSeatsLine({ spec }: { spec: SpecView }) {
  const { config } = spec.run
  return (
    <span className="text-xs text-foreground/75">
      <FormattedMessage
        id="spec.seats"
        defaultMessage="Candidates {candidates} · judge {judge} · lead {lead}"
        values={{
          candidates: <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 align-middle">{config.candidates.map((c, i) => <ProviderLabel key={i} id={c.providerId} />)}</span>,
          judge: <ProviderLabel id={config.judge.providerId} />,
          lead: <ProviderLabel id={config.lead.providerId} />,
        }}
      />
    </span>
  )
}

/**
 * Every agent the spec has run, behind one line that says what it cost so far
 * (calls and wall-clock time) and, while closed, who is working right now. Each
 * row opens to that agent's recorded output — the same row as the Workflow panel.
 */
export function SpecAgentList({ spec, onOpenChat }: { spec: SpecView; onOpenChat?: (chat: SpecChatRef) => void }) {
  const [open, setOpen] = useState(false)
  if (spec.agents.length === 0) return null
  const working = spec.agents.filter((a) => a.state === 'running')
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-2 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 font-medium tabular-nums">
          <FormattedMessage
            id="spec.agents.calls"
            defaultMessage="{count, plural, one {# agent call} other {# agent calls}}"
            values={{ count: spec.agents.length }}
          />
        </span>
        <span aria-hidden className="h-3 w-px shrink-0 bg-border/60" />
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground/70">
          <Clock className="h-3 w-3" aria-hidden />
          {formatDuration(spec.elapsedMs)}
        </span>
        {working.length > 0 && (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-status-info">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
            <span className="truncate">{working.map((a) => fileCitationsToText(a.label)).join(', ')}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="scroll-fade-y max-h-[60vh] space-y-2 overflow-y-auto">
          {spec.agents.map((agent, i) => (
            <div key={`${agent.runId}:${agent.index}`} className="space-y-1.5">
              {agent.phase && agent.phase !== spec.agents[i - 1]?.phase && (
                <div className={cn("heading-section px-1 pb-0.5", i > 0 && "pt-3")}>{agent.phase}</div>
              )}
              <AgentRow
                runId={agent.runId}
                agent={{ ...agent, chatIds: agent.chats?.map((c) => c.chatId) }}
                stream={undefined}
                referenceRootPath={agent.chats?.at(-1)?.cwd ?? null}
                onOpenChat={
                  onOpenChat
                    ? (chatId) => {
                        const chat = agent.chats?.find((c) => c.chatId === chatId)
                        if (chat) onOpenChat(chat)
                      }
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Stop a running spec, as a compact header control: the chat card keeps it
 * beside its other buttons instead of spending a row on it below the card.
 */
export function SpecStopButton({ spec, className }: { spec: SpecView; className?: string }) {
  const intl = useIntl()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = intl.formatMessage({ id: 'spec.action.stop', defaultMessage: 'Stop' })
  const stop = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.specStop(spec.taskId)
      notifySpecChanged(spec.taskId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn(
        'h-7 w-7 p-0 text-muted-foreground hover:bg-status-error/10 hover:text-status-error',
        error && 'text-status-error',
        className,
      )}
      disabled={busy}
      onClick={() => void stop()}
      aria-label={label}
      // The failure has nowhere else to go on a button this small.
      title={error ?? label}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
    </Button>
  )
}

/**
 * What the user can do with a spec right now — the same buttons on the chat card
 * and the task page, because both gates are one act wherever they are pressed.
 * `showStop` off: the caller shows `SpecStopButton` itself.
 * `showSwitch` off: switching is hidden here or shown beside the coordinator.
 */
export function SpecActions({ spec, showStop = true, showSwitch = true, showResume = true }: { spec: SpecView; showStop?: boolean; showSwitch?: boolean; showResume?: boolean }) {
  const intl = useIntl()
  // On a phone the gates are thumb targets: taller buttons that share the row.
  const btn = useGateButtonClass()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [implementers, setImplementers] = useState<Record<string, string>>({})
  const [concurrency, setConcurrency] = useState<number | undefined>(undefined)
  const stage = spec.run.stage
  // Signed at gate 1: the design is settled, only the build can stop and resume.
  const signed = spec.run.designSha != null

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
      notifySpecChanged(spec.taskId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (stage === 'done') return null
  const proposal = spec.run.proposal ? <SpecProposalBanner spec={spec} /> : null
  if ((stage === 'building' || stage === 'reviewing') && !spec.designChanged) {
    if (!proposal && !showSwitch && !(spec.running && showStop) && !error) return null
    return (
      <div className="space-y-2">
        {proposal}
        <div className="flex flex-wrap items-center gap-2">
          {showSwitch && <SpecSwitchButton spec={spec} />}
          {spec.running && showStop && (
            <Button
              size="sm"
              variant="ghost"
              className={btn}
              disabled={busy != null}
              onClick={() => void act('stop', () => api.specStop(spec.taskId))}
            >
              {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              <FormattedMessage id="spec.action.stop" defaultMessage="Stop" />
            </Button>
          )}
        </div>
        {error && <div className="flex items-center gap-2 text-xs text-destructive">{error}</div>}
      </div>
    )
  }

  if (stage === 'integrating') {
    return (
      <div className="space-y-2">
        {proposal}
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-info" />
          <span>
            <FormattedMessage
              id="spec.integrating"
              defaultMessage="Signing off hit a conflict merging {target} in ({files}). The coordinator is resolving it; a reviewer from another model family checks the result, then you sign off again."
              values={{
                target: spec.integration?.target ?? '—',
                files: spec.integration?.files.join(', ') || '—',
              }}
            />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RequestChanges
            disabled={busy != null}
            busy={busy === 'changes'}
            placeholder={intl.formatMessage({
              id: 'spec.changes.signoffPlaceholder',
              defaultMessage: 'What should change before this is merged?',
            })}
            onSend={(comment) => act('changes', () => api.specRequestChanges(spec.taskId, { comment, redesign: false }))}
          />
        </div>
        {error && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}
      </div>
    )
  }

  if (stage === 'building') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-status-warn">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <FormattedMessage
            id="spec.designChanged"
            defaultMessage="The design changed after you approved it. Review it and approve again before more tickets start."
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          className={btn}
          disabled={busy != null}
          onClick={() => void act('reapprove', () => api.specReapprove(spec.taskId))}
        >
          {busy === 'reapprove' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          <FormattedMessage id="spec.action.reapprove" defaultMessage="Approve changed design" />
        </Button>
        {error && <div className="flex items-center gap-2 text-xs text-destructive">{error}</div>}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {proposal}
      <div className="flex flex-wrap items-center gap-2">
        {stage === 'awaiting_design' && (
          <Button
            size="sm"
            variant="secondary"
            className={btn}
            disabled={busy != null}
            onClick={() => void act('approve', () => api.specApprove(spec.taskId, implementers, concurrency))}
          >
            {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            <FormattedMessage id="spec.action.approve" defaultMessage="Approve design" />
          </Button>
        )}
        {stage === 'awaiting_signoff' && (
          <Button
            size="sm"
            variant="secondary"
            className={btn}
            disabled={busy != null}
            onClick={() => void act('signoff', () => api.specSignOff(spec.taskId))}
          >
            {busy === 'signoff' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
            <FormattedMessage id="spec.action.signOff" defaultMessage="Sign off and merge" />
          </Button>
        )}
        {stage === 'awaiting_signoff' && (
          <RequestChanges
            disabled={busy != null}
            busy={busy === 'changes'}
            placeholder={intl.formatMessage({
              id: 'spec.changes.signoffPlaceholder',
              defaultMessage: 'What should change before this is merged?',
            })}
            onSend={(comment) => act('changes', () => api.specRequestChanges(spec.taskId, { comment, redesign: false }))}
          />
        )}
        {stage === 'awaiting_design' && spec.tickets && spec.tickets.length > 0 && (
          <BuildersPicker
            spec={spec}
            value={implementers}
            onChange={setImplementers}
            concurrency={concurrency ?? spec.run.config.concurrency ?? DEFAULT_CONCURRENCY}
            onConcurrencyChange={setConcurrency}
            disabled={busy != null}
          />
        )}
        {!signed && (stage === 'awaiting_design' || stage === 'awaiting_answers' || stage === 'stopped' || stage === 'failed') && (
          <RequestChanges
            disabled={busy != null}
            busy={busy === 'changes'}
            onSend={(comment, redesign) =>
              act('changes', () => api.specRequestChanges(spec.taskId, { comment, redesign }))
            }
          />
        )}
        {showResume && (stage === 'stopped' || stage === 'failed') && (
          <Button
            size="sm"
            variant="secondary"
            className={btn}
            disabled={busy != null}
            onClick={() => void act('resume', () => api.specResume(spec.taskId))}
          >
            {busy === 'resume' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            <FormattedMessage id="spec.action.resume" defaultMessage="Resume" />
          </Button>
        )}
        {/* What stopped it is usually the agent (quota, a login): put another on the role and carry on. */}
        {showSwitch && (stage === 'stopped' || stage === 'failed') && <SpecSwitchButton spec={spec} />}
        {spec.running && showStop && (
          <Button
            size="sm"
            variant="ghost"
            className={btn}
            disabled={busy != null}
            onClick={() => void act('stop', () => api.specStop(spec.taskId))}
          >
            {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            <FormattedMessage id="spec.action.stop" defaultMessage="Stop" />
          </Button>
        )}
      </div>
      {stage === 'awaiting_answers' && spec.questions && spec.questions.length > 0 && (
        <SpecQuestions
          spec={spec}
          busy={busy === 'answer'}
          onSend={(answers) => act('answer', () => api.specAnswer(spec.taskId, answers))}
        />
      )}
      {(stage === 'failed' || stage === 'stopped') && spec.run.error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {spec.run.error}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * Whether the spec waits on the user for more than a Stop button: a gate to
 * sign, questions to answer, a stopped run to resume. While it just runs,
 * there is nothing below the card's header to show.
 */
export function specHasGate(spec: SpecView): boolean {
  if (spec.run.proposal) return true
  const stage = spec.run.stage
  if (stage === 'building') return spec.designChanged
  return (
    stage === 'awaiting_answers' ||
    stage === 'awaiting_design' ||
    stage === 'awaiting_signoff' ||
    stage === 'integrating' ||
    stage === 'stopped' ||
    stage === 'failed'
  )
}

/** 'Lead', 'Candidate B', 'Reviewer of T2'. */
export function roleLabel(intl: IntlShape, seat: Pick<SpecSwitch, 'role' | 'index' | 'ticketKey'>): string {
  const names: Record<SpecRole, string> = {
    lead: intl.formatMessage({ id: 'spec.role.lead', defaultMessage: 'Lead' }),
    explorer: intl.formatMessage({ id: 'spec.role.explorer', defaultMessage: 'Explorer' }),
    candidate: intl.formatMessage(
      { id: 'spec.role.candidate', defaultMessage: 'Candidate {letter}' },
      { letter: String.fromCharCode(65 + (seat.index ?? 0)) },
    ),
    judge: intl.formatMessage({ id: 'spec.role.judge', defaultMessage: 'Judge' }),
    builder: intl.formatMessage({ id: 'spec.role.builder', defaultMessage: 'Builder check' }),
    implementer: intl.formatMessage({ id: 'spec.role.implementer', defaultMessage: 'Implementer' }),
    reviewer: intl.formatMessage({ id: 'spec.role.reviewer', defaultMessage: 'Reviewer' }),
    coordinator: intl.formatMessage({ id: 'spec.role.coordinator', defaultMessage: 'Coordinator' }),
  }
  const name = names[seat.role]
  return seat.ticketKey
    ? intl.formatMessage({ id: 'spec.role.ofTicket', defaultMessage: '{role} of {ticket}' }, { role: name, ticket: seat.ticketKey })
    : name
}

function seatKey(seat: Pick<SpecSeatView, 'role' | 'index' | 'ticketKey'>): string {
  return `${seat.role}:${seat.index ?? ''}:${seat.ticketKey ?? ''}`
}

/**
 * Move a role to another agent or model — what to do when one runs out of
 * quota, will not log in, keeps failing. With `ticketKey` it offers that
 * ticket's implementer and reviewer; otherwise every seat of the spec.
 */
export function SpecSwitchButton({ spec, ticketKey, compact }: { spec: SpecView; ticketKey?: string; compact?: boolean }) {
  const intl = useIntl()
  const btn = useGateButtonClass()
  const seats = spec.seats.filter((s) => (ticketKey ? s.ticketKey === ticketKey : !s.ticketKey))
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string>(() => (seats[0] ? seatKey(seats[0]) : ''))
  const [to, setTo] = useState<SpecSeat | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = seats.find((s) => seatKey(s) === picked) ?? seats[0]
  if (!current) return null

  const apply = async () => {
    if (!to) return
    setBusy(true)
    setError(null)
    try {
      await api.specSwitch(spec.taskId, {
        role: current.role,
        ...(current.index != null ? { index: current.index } : {}),
        ...(current.ticketKey ? { ticketKey: current.ticketKey } : {}),
        providerId: to.providerId,
        ...(to.modelId ? { modelId: to.modelId } : {}),
      })
      setOpen(false)
      setTo(null)
      notifySpecChanged(spec.taskId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <GateSheet
      open={open}
      onOpenChange={setOpen}
      title={intl.formatMessage({ id: 'spec.switch.title', defaultMessage: 'Switch an agent' })}
      className="w-96 space-y-3"
      trigger={
        <Button size="sm" variant="ghost" className={compact ? 'h-7 gap-1.5 text-xs' : btn}>
          <ArrowLeftRight className="h-3.5 w-3.5" />
          <FormattedMessage id="spec.switch.trigger" defaultMessage="Switch agent" />
        </Button>
      }
    >
      <div className="text-xs text-muted-foreground">
        <FormattedMessage
          id="spec.switch.hint"
          defaultMessage="Out of quota, logged out, or failing? Put another agent on the role. What runs next uses it; a ticket's implementer hands its work over at once, and a stopped spec carries on."
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-medium">
          <FormattedMessage id="spec.switch.role" defaultMessage="Role" />
        </div>
        <Select value={seatKey(current)} onValueChange={(k) => { setPicked(k); setTo(null) }}>
          <SelectTrigger size="sm" className="h-8 w-full border-border/50 bg-background/80 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {seats.map((s) => (
              <SelectItem key={seatKey(s)} value={seatKey(s)} className="text-xs">
                {roleLabel(intl, s)} · <ProviderLabel id={s.seat.providerId}>{seatName(s.seat)}</ProviderLabel>
                {s.auto ? ` (${intl.formatMessage({ id: 'spec.switch.auto', defaultMessage: 'automatic' })})` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-medium">
          <FormattedMessage id="spec.switch.to" defaultMessage="Switch to" />
        </div>
        <SeatPicker value={to} providers={spec.availableProviders} onChange={setTo} />
      </div>
      {error && (
        <div className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={!to || busy} onClick={() => void apply()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
          <FormattedMessage id="spec.switch.apply" defaultMessage="Switch" />
        </Button>
      </div>
    </GateSheet>
  )
}

/** The coordinator asks to move a role to another agent; nothing changes until the user says yes. */
export function SpecProposalBanner({ spec }: { spec: SpecView }) {
  const intl = useIntl()
  const btn = useGateButtonClass()
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const proposal = spec.run.proposal
  if (!proposal) return null
  const act = async (name: 'accept' | 'dismiss') => {
    setBusy(name)
    setError(null)
    try {
      if (name === 'accept') await api.specAcceptProposal(spec.taskId)
      else await api.specDismissProposal(spec.taskId)
      notifySpecChanged(spec.taskId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-status-warn/30 bg-status-warn/5 px-3 py-2">
      <div className="flex items-start gap-2 text-xs">
        <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium text-foreground">
            <FormattedMessage
              id="spec.proposal.title"
              defaultMessage="The coordinator suggests switching {role} from {from} to {to}"
              values={{ role: roleLabel(intl, proposal), from: proposal.from ? <ProviderLabel id={proposal.from.providerId}>{seatName(proposal.from)}</ProviderLabel> : seatName(proposal.from), to: <ProviderLabel id={proposal.to.providerId}>{seatName(proposal.to)}</ProviderLabel> }}
            />
          </div>
          <div className="text-muted-foreground">{proposal.reason}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" className={btn} disabled={busy != null} onClick={() => void act('accept')}>
          {busy === 'accept' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
          <FormattedMessage id="spec.proposal.accept" defaultMessage="Switch" />
        </Button>
        <Button size="sm" variant="ghost" className={btn} disabled={busy != null} onClick={() => void act('dismiss')}>
          {busy === 'dismiss' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          <FormattedMessage id="spec.proposal.dismiss" defaultMessage="Don't switch" />
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  )
}

/** Gate buttons: compact beside a mouse, tall and sharing the row on a phone. */
function useGateButtonClass(): string {
  return useIsMobile() ? 'h-10 min-w-[calc(50%-0.25rem)] flex-1 gap-1.5 text-sm' : 'h-8 gap-1.5'
}

/**
 * A gate's secondary choices (who builds, what to change): a popover beside a
 * mouse, a bottom sheet on a phone, where a fixed-width popover would run off
 * the screen and sit under the keyboard.
 */
function GateSheet({
  trigger,
  title,
  className,
  open: controlled,
  onOpenChange,
  children,
}: {
  trigger: ReactElement<{ onClick?: () => void }>
  title: string
  /** Popover width and spacing; the sheet takes the screen's width. */
  className: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const isMobile = useIsMobile()
  const [own, setOwn] = useState(false)
  const open = controlled ?? own
  const setOpen = onOpenChange ?? setOwn
  if (isMobile) {
    return (
      <>
        {cloneElement(trigger, { onClick: () => setOpen(true) })}
        <MobileSheet open={open} onClose={() => setOpen(false)} title={title} bodyClassName="space-y-3 px-4 pb-4">
          {children}
        </MobileSheet>
      </>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className={cn('rounded-xl border border-border/60 bg-popover p-3 shadow-float', className)}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** The build's default and choosable concurrency — mirrors the server's DEFAULT_CONCURRENCY / MAX_CONCURRENCY. */
const DEFAULT_CONCURRENCY = 3
const CONCURRENCY_CHOICES = [1, 2, 3, 4, 5]

/**
 * Who builds each ticket, chosen before signing: one line that says the default,
 * opening to a provider per ticket. Reviewers follow from it (another family).
 */
function BuildersPicker({
  spec,
  value,
  onChange,
  concurrency,
  onConcurrencyChange,
  disabled,
}: {
  spec: SpecView
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
  /** How many tickets are built at once; the frontier never starts more. */
  concurrency: number
  onConcurrencyChange: (next: number) => void
  disabled: boolean
}) {
  const intl = useIntl()
  const btn = useGateButtonClass()
  const fallback = spec.run.config.implementer?.providerId ?? spec.providers[0]
  const chosen = new Set((spec.tickets ?? []).map((t) => value[t.key] ?? fallback))
  return (
    <GateSheet
      title={intl.formatMessage({ id: 'spec.builders.title', defaultMessage: 'Who builds the tickets' })}
      className="w-96 space-y-2"
      trigger={
        <Button size="sm" variant="ghost" className={btn} disabled={disabled}>
          <Hammer className="h-3.5 w-3.5" />
          <FormattedMessage
            id="spec.builders.trigger"
            defaultMessage="Built by {providers}"
            values={{ providers: <span className="inline-flex flex-wrap items-center gap-2">{[...chosen].filter((p): p is string => !!p).map((p) => <ProviderLabel key={p} id={p} />)}</span> }}
          />
        </Button>
      }
    >
      <div className="text-xs text-muted-foreground">
        {/* Reviewers come from the spec's own agents; with only one, it reviews itself. */}
        {spec.providers.length > 1 ? (
          <FormattedMessage
            id="spec.builders.hint"
            defaultMessage="Who builds each ticket. A reviewer from another model family checks every ticket before it is merged."
          />
        ) : (
          <FormattedMessage
            id="spec.builders.hintSingle"
            defaultMessage="Who builds each ticket. This spec uses one agent, so a separate session of the same agent reviews every ticket before it is merged."
          />
        )}
      </div>
      <div className="space-y-1">
        {spec.tickets?.map((t) => (
          <div key={t.key} className="flex items-center gap-2 rounded-lg px-1 py-0.5">
            <span className="w-7 shrink-0 font-mono text-xs text-muted-foreground">{t.key}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
            <Select value={value[t.key] ?? fallback} onValueChange={(provider) => onChange({ ...value, [t.key]: provider })}>
              <SelectTrigger size="sm" className="h-7 w-32 shrink-0 border-border/50 bg-background/80 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {spec.providers.map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">
                    <ProviderLabel id={p} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-border/40 px-1 pt-2">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          <FormattedMessage id="spec.builders.concurrency" defaultMessage="Tickets built at once" />
        </span>
        <Select value={String(concurrency)} onValueChange={(n) => onConcurrencyChange(Number(n))}>
          <SelectTrigger size="sm" className="h-7 w-32 shrink-0 border-border/50 bg-background/80 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONCURRENCY_CHOICES.map((n) => (
              <SelectItem key={n} value={String(n)} className="text-xs">
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </GateSheet>
  )
}

function RequestChanges({
  disabled,
  busy,
  onSend,
  placeholder,
}: {
  disabled: boolean
  busy: boolean
  onSend: (comment: string, redesign: boolean) => Promise<void>
  /** Set at gate 2, where there is no design to redo: also hides the redesign switch. */
  placeholder?: string
}) {
  const intl = useIntl()
  const btn = useGateButtonClass()
  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [redesign, setRedesign] = useState(false)

  const send = async () => {
    if (!comment.trim()) return
    await onSend(comment.trim(), redesign)
    setComment('')
    setRedesign(false)
    setOpen(false)
  }

  return (
    <GateSheet
      open={open}
      onOpenChange={setOpen}
      title={intl.formatMessage({ id: 'spec.action.requestChanges', defaultMessage: 'Request changes' })}
      className="w-80 space-y-3"
      trigger={
        <Button size="sm" variant="ghost" className={btn} disabled={disabled}>
          <MessageSquareText className="h-3.5 w-3.5" />
          <FormattedMessage id="spec.action.requestChanges" defaultMessage="Request changes" />
        </Button>
      }
    >
      <Textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={
          placeholder ??
          intl.formatMessage({
            id: 'spec.changes.placeholder',
            defaultMessage: 'What should change in the design?',
          })
        }
        className="min-h-24 text-sm"
        autoFocus
      />
      {!placeholder && (
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <Switch checked={redesign} onCheckedChange={setRedesign} className="mt-0.5" />
          <span>
            <FormattedMessage
              id="spec.changes.redesign"
              defaultMessage="Discard the candidates and design again from scratch (otherwise only the synthesis is redone)"
            />
          </span>
        </label>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" className={btn} disabled={busy || !comment.trim()} onClick={() => void send()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          <FormattedMessage id="spec.changes.send" defaultMessage="Send" />
        </Button>
      </div>
    </GateSheet>
  )
}

function SpecQuestions({
  spec,
  busy,
  onSend,
}: {
  spec: SpecView
  busy: boolean
  onSend: (answers: string) => Promise<void>
}) {
  const intl = useIntl()
  const btn = useGateButtonClass()
  const [answers, setAnswers] = useState('')
  return (
    <div className="space-y-2 rounded-lg border border-border/40 bg-background/40 p-3">
      <ol className="list-decimal space-y-1.5 pl-4 text-sm">
        {spec.questions?.map((q, i) => (
          <li key={i}>
            <span className="text-foreground">{q.question}</span>
            {q.why && <span className="block text-xs text-muted-foreground">{q.why}</span>}
          </li>
        ))}
      </ol>
      <div className="text-xs text-muted-foreground">
        <FormattedMessage
          id="spec.questions.hint"
          defaultMessage="Answer in the chat, or here — numbered to match."
        />
      </div>
      <Textarea
        value={answers}
        onChange={(e) => setAnswers(e.target.value)}
        placeholder={intl.formatMessage({ id: 'spec.questions.placeholder', defaultMessage: '1. …' })}
        className="min-h-20 text-sm"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          className={btn}
          disabled={busy || !answers.trim()}
          onClick={() => void onSend(answers.trim()).then(() => setAnswers(''))}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          <FormattedMessage id="spec.questions.send" defaultMessage="Send answers" />
        </Button>
      </div>
    </div>
  )
}

/** Markdown look for design documents — the same reading rhythm as the rest of the task page. */
export const SPEC_MARKDOWN_CLASS = cn(
  'text-[13px] text-foreground',
  'prose-headings:font-semibold prose-headings:tracking-normal prose-h1:mb-3 prose-h1:text-lg',
  'prose-h2:mt-6 prose-h2:mb-2 prose-h2:border-t prose-h2:border-border/40 prose-h2:pt-5 prose-h2:text-xs',
  'prose-h2:uppercase prose-h2:tracking-[0.08em] prose-h2:text-foreground',
  '[&>:first-child]:mt-0 [&>h2:first-child]:border-t-0 [&>h2:first-child]:pt-0',
  'prose-h3:mt-4 prose-h3:mb-1.5 prose-h3:text-sm prose-h4:mt-4 prose-h4:mb-1.5 prose-h4:text-sm',
  'prose-p:my-1 prose-p:leading-6 prose-li:my-1 prose-li:leading-6 prose-ul:my-2 prose-ol:my-2',
  'prose-strong:text-foreground',
)

const TICKET_TONE: Record<SpecTicketState, string> = {
  waiting: 'text-muted-foreground',
  building: 'text-status-info',
  reviewing: 'text-status-info',
  merged: 'text-status-ok',
  blocked: 'text-status-error',
}

function ticketStateLabel(intl: IntlShape, state: SpecTicketState): string {
  switch (state) {
    case 'waiting':
      return intl.formatMessage({ id: 'spec.ticketState.waiting', defaultMessage: 'Waiting' })
    case 'building':
      return intl.formatMessage({ id: 'spec.ticketState.building', defaultMessage: 'Building' })
    case 'reviewing':
      return intl.formatMessage({ id: 'spec.ticketState.reviewing', defaultMessage: 'In review' })
    case 'merged':
      return intl.formatMessage({ id: 'spec.ticketState.merged', defaultMessage: 'Merged' })
    case 'blocked':
      return intl.formatMessage({ id: 'spec.ticketState.blocked', defaultMessage: 'Blocked' })
  }
}

/**
 * Where one ticket stands in the build: state, who builds and reviews it, rework
 * so far, and why it is stuck. A stuck ticket is moved on by a person in its own
 * session: once they get its implementer to hand it in, review picks it up again
 * with its rounds reset — so the way out is a link to that session.
 */
export function TicketBuildLine({
  build,
  spec,
  onOpenSession,
}: {
  build: SpecTicketBuild
  /** Offers switching its implementer or reviewer while it is not merged. */
  spec?: SpecView
  onOpenSession?: () => void
}) {
  const intl = useIntl()
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={cn('font-medium', TICKET_TONE[build.state])}>{ticketStateLabel(intl, build.state)}</span>
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">
          <ProviderLabel id={build.implementer}>{build.implementerModelId ? `${build.implementer} · ${build.implementerModelId}` : build.implementer}</ProviderLabel>
          <span>→</span>
          <ProviderLabel id={build.reviewer} />
        </span>
        {build.rounds > 0 && (
          <span className="text-muted-foreground">
            <FormattedMessage
              id="spec.ticket.rounds"
              defaultMessage="{count, plural, one {# review round sent back} other {# review rounds sent back}}"
              values={{ count: build.rounds }}
            />
          </span>
        )}
        {((onOpenSession && build.state !== 'waiting') || (spec && build.state !== 'merged')) && (
          <div className="flex flex-wrap items-center gap-2">
            {onOpenSession && build.state !== 'waiting' && (
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-1.5 text-xs" onClick={onOpenSession}>
                <ExternalLink className="h-3.5 w-3.5" />
                <FormattedMessage id="spec.ticket.openSession" defaultMessage="Open its session" />
              </Button>
            )}
            {spec && build.state !== 'merged' && <SpecSwitchButton spec={spec} ticketKey={build.key} compact />}
          </div>
        )}
      </div>
      {build.state === 'blocked' && build.blockedReason && (
        <div className="flex items-start gap-1.5 text-xs text-status-error">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{build.blockedReason}</span>
        </div>
      )}
      {build.state === 'blocked' && build.coordinator === 'asked' && (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <FormattedMessage id="spec.ticket.coordinatorAsked" defaultMessage="The coordinator is looking at it." />
        </div>
      )}
      {build.state === 'blocked' && (
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="spec.ticket.blockedHint"
            defaultMessage="Get its agent moving there, or switch it to another agent; once it hands the ticket in, review picks it up again."
          />
        </p>
      )}
    </div>
  )
}

/** The coordinator's identity and live status in the Spec header. */
export function SpecCoordinatorLine({ spec }: { spec: SpecView }) {
  const coordinator = spec.coordinator
  if (!coordinator) return null
  const active = coordinator.status === 'active'
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground/75">
      <span>
        <FormattedMessage
          id="spec.coordinator.line"
          defaultMessage="Coordinated by {provider}"
          values={{ provider: <ProviderLabel id={coordinator.providerId}>{coordinator.modelId ? `${coordinator.providerId} · ${coordinator.modelId}` : coordinator.providerId}</ProviderLabel> }}
        />
      </span>
      {active && (
        <span className="inline-flex items-center gap-1 text-status-info">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-info" />
          <FormattedMessage id="spec.coordinator.working" defaultMessage="working" />
        </span>
      )}

    </div>
  )
}

/**
 * What a gate asks the user to sign, in one line, for the chat card — where on a
 * phone the user decides without the task page's tabs: the tickets the design
 * splits into at gate 1; at gate 2, what the review left open and what the
 * change will record.
 */
export function SpecGateSummary({ spec }: { spec: SpecView }) {
  const stage = spec.run.stage
  if (stage === 'awaiting_design' && spec.tickets) {
    return (
      <div className="text-xs text-muted-foreground">
        <FormattedMessage
          id="spec.gate.design"
          defaultMessage="{count, plural, one {Splits into # ticket} other {Splits into # tickets}}"
          values={{ count: spec.tickets.length }}
        />
      </div>
    )
  }
  if (stage !== 'awaiting_signoff' || !spec.reviewSummary) return null
  const r = spec.reviewSummary
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-x-1.5">
        <span className={cn(r.actOn > 0 && 'text-status-error')}>
          <FormattedMessage id="spec.gate.actOn" defaultMessage="{count} to act on" values={{ count: r.actOn }} />
        </span>
        <span>·</span>
        <span className={cn(r.fail > 0 && 'text-status-error')}>
          <FormattedMessage id="spec.gate.failing" defaultMessage="{count} failing" values={{ count: r.fail }} />
        </span>
        <span>·</span>
        <span className={cn(r.notRun > 0 && 'text-status-warn')}>
          <FormattedMessage id="spec.gate.notRun" defaultMessage="{count} not verified" values={{ count: r.notRun }} />
        </span>
      </div>
      {r.summary && <div className="line-clamp-3 text-foreground/80">{fileCitationsToText(r.summary)}</div>}
    </div>
  )
}

/** One line for the chat card while tickets are built: how many are in, how many need someone. */
export function SpecBuildSummary({ spec }: { spec: SpecView }) {
  const build = spec.run.build
  if (build.length === 0) return null
  const merged = build.filter((b) => b.state === 'merged').length
  const blocked = build.filter((b) => b.state === 'blocked').length
  return (
    <div className="text-xs text-foreground/75">
      <FormattedMessage
        id="spec.build.summary"
        defaultMessage="{merged} of {total} tickets merged"
        values={{ merged, total: build.length }}
      />
      {blocked > 0 && (
        <span className="text-status-error">
          {' · '}
          <FormattedMessage
            id="spec.build.blocked"
            defaultMessage="{count, plural, one {# blocked} other {# blocked}}"
            values={{ count: blocked }}
          />
        </span>
      )}
    </div>
  )
}

/**
 * The spec's place on its board card: the stage (with merged/total while
 * building), or "Blocked" when something waits on a person. A ticket shows only
 * "Blocked" — its column already says the rest.
 */
export function SpecCardBadge({ task }: { task: Pick<TaskListItem, 'specStage' | 'specProgress' | 'ticketState'> }) {
  const intl = useIntl()
  const blocked = task.ticketState === 'blocked' || (task.specProgress?.blocked ?? 0) > 0
  if (blocked) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-medium text-status-error bg-status-error/10">
        <AlertCircle className="h-2.5 w-2.5" aria-hidden />
        <FormattedMessage id="spec.card.blocked" defaultMessage="Blocked" />
      </span>
    )
  }
  if (task.specStage == null) return null
  // Approved before the build stage existed: nothing is being built by it.
  if (task.specStage === 'building' && !task.specProgress) return null
  const progress =
    task.specStage === 'building' && task.specProgress ? ` ${task.specProgress.merged}/${task.specProgress.total}` : ''
  return (
    <span className={cn('rounded px-1 text-[10px] font-medium tabular-nums', STAGE_TONE[task.specStage])}>
      {stageLabel(intl, task.specStage)}
      {progress}
    </span>
  )
}
