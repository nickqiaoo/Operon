import { useEffect, useState } from "react"
import { ArrowLeft, ArrowUp, CheckCircle2, ChevronRight, Circle, Loader2, Square, X, XCircle } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { MessageResponse } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Activity, ActivityStep } from "./types"
import { ActivityStatusBadge, formatClock } from "./shared"
import { ACTIVITY_STATUS_MESSAGES, AGENT_MESSAGES, activitySummary } from "./assistant-i18n"
import { DrawerShell, useDrawer } from "./Drawer"

interface ActivityDrawerProps {
  activity: Activity | null
  onClose: () => void
  onStop: (id: string) => void
  onFollowUp: (id: string, text: string) => void
}

/**
 * One worker's run, slid in over the right rail. Non-modal: the thread stays
 * usable underneath, so you can keep talking while you watch it work.
 */
export function ActivityDrawer({ activity, onClose, onStop, onFollowUp }: ActivityDrawerProps) {
  const { shown, active } = useDrawer(activity, onClose)
  if (!shown) return null
  return (
    <DrawerShell active={active}>
      <ActivityDetail activity={shown} onClose={onClose} onStop={onStop} onFollowUp={onFollowUp} />
    </DrawerShell>
  )
}

interface ActivityDetailProps {
  activity: Activity
  /**
   * `split` (drawer): the steps on the left; on the right the overall summary, or —
   * once a step is picked — that step's tool call and what came back.
   * `stacked` (phone): one column, the summary above the steps.
   */
  layout?: "split" | "stacked"
  /** Shows a close button in the header. */
  onClose?: () => void
  onStop: (id: string) => void
  onFollowUp: (id: string, text: string) => void
}

/** The run itself: header, steps and summary, and a box to steer or follow up on it. */
export function ActivityDetail({ activity, layout = "split", onClose, onStop, onFollowUp }: ActivityDetailProps) {
  const intl = useIntl()
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  // A different activity starts on its summary.
  useEffect(() => {
    setSelectedStepId(null)
  }, [activity.id])

  const live = activity.status === "running" || activity.status === "waiting"
  const selectedStep = activity.steps.find((s) => s.id === selectedStepId) ?? null
  const stacked = layout === "stacked"
  // The main agent's own work has no task behind it to steer, continue or stop.
  const byMain = activity.agent === "main"
  const agentLabel = intl.formatMessage(AGENT_MESSAGES[byMain ? "main" : "worker"])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    onFollowUp(activity.id, text)
    setDraft("")
  }

  const timeline = (
    <Timeline
      steps={activity.steps}
      running={activity.status === "running"}
      selectedId={selectedStepId}
      large={stacked}
      onSelect={(id) => setSelectedStepId((cur) => (cur === id ? null : id))}
    />
  )
  const meta = (
    <>
      <FormattedMessage
        id="assistant.activity.startedAt"
        defaultMessage="Started {time}"
        values={{ time: formatClock(activity.startedAt) }}
      />
      {activity.finishedAt && (
        <>
          {" · "}
          <FormattedMessage
            id="assistant.activity.finishedAt"
            defaultMessage="finished {time}"
            values={{ time: formatClock(activity.finishedAt) }}
          />
        </>
      )}
      {activity.source === "heartbeat" && (
        <>
          {" · "}
          <FormattedMessage id="assistant.activity.byHeartbeat" defaultMessage="by heartbeat" />
        </>
      )}
      {activity.source === "schedule" && (
        <>
          {" · "}
          <FormattedMessage id="assistant.activity.bySchedule" defaultMessage="by schedule" />
        </>
      )}
    </>
  )
  const summary = (
    <>
      <div className="mb-2 text-sm font-semibold">
        <FormattedMessage id="assistant.activity.summary" defaultMessage="Summary" />
      </div>
      {activity.report ? (
        <MessageResponse className="text-sm">{activity.report}</MessageResponse>
      ) : (
        <div className="text-sm text-muted-foreground">{activitySummary(intl, activity.summary)}</div>
      )}
    </>
  )

  const composer = (
    <div className="flex shrink-0 items-center gap-2 border-t border-border/40 px-4 py-3">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) submit()
        }}
        placeholder={
          live
            ? intl.formatMessage({ id: "assistant.activity.steerPlaceholder", defaultMessage: "Tell this task something…" })
            : intl.formatMessage({ id: "assistant.activity.followUpPlaceholder", defaultMessage: "Follow up on this task…" })
        }
        className={cn(
          "min-w-0 flex-1 rounded-lg border border-border/50 bg-background/60 px-3 outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-border dark:border-border/35",
          // 16px on phones, or iOS zooms the page in on focus.
          stacked ? "h-9 text-base" : "h-8 text-sm",
        )}
      />
      <Button
        size="sm"
        variant="secondary"
        className={cn("p-0", stacked ? "h-9 w-9" : "h-8 w-8")}
        onClick={submit}
        disabled={!draft.trim()}
        title={intl.formatMessage({ id: "assistant.send", defaultMessage: "Send" })}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      {live && (
        <Button size="sm" variant="ghost" className={cn("gap-1.5", stacked ? "h-9" : "h-8")} onClick={() => onStop(activity.id)}>
          <Square className="h-3.5 w-3.5" />
          <FormattedMessage id="assistant.activity.stop" defaultMessage="Stop" />
        </Button>
      )}
    </div>
  )

  if (stacked) {
    // The phone's sheet: one column at reading size — what it is, what came of
    // it, then who did it and how.
    return (
      <>
        <div className="flex shrink-0 items-start gap-3 border-b border-border/40 px-5 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <ActivityStatusBadge status={activity.status} large />
            <div className="mt-3 text-xl font-bold leading-snug">{activity.title}</div>
            <div className="mt-2 text-base text-foreground/80">{activitySummary(intl, activity.summary)}</div>
            <div className="mt-2 text-sm text-muted-foreground">{meta}</div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={intl.formatMessage({ id: "assistant.close", defaultMessage: "Close" })}
              className="liquid-glass flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/80 transition-transform active:scale-[0.94]"
            >
              <X className="size-5" />
            </button>
          )}
        </div>

        {/* data-sheet-scroll: on the phone's sheet this scrolls only once the sheet is opened up. */}
        <div data-sheet-scroll className="scroll-fade-y min-h-0 flex-1 overflow-y-auto">
          {selectedStep ? (
            <div className="px-5 py-4">
              <StepDetail step={selectedStep} onBack={() => setSelectedStepId(null)} />
            </div>
          ) : (
            <>
              {activity.report && (
                <div className="border-b border-border/40 px-5 py-4">
                  <MessageResponse className="text-base leading-relaxed">{activity.report}</MessageResponse>
                </div>
              )}
              <div className="px-5 pb-1 pt-4 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
                {agentLabel}
              </div>
              <div className="px-2 pb-4">{timeline}</div>
            </>
          )}
        </div>
        {!byMain && composer}
      </>
    )
  }

  return (
    <>
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div className="min-w-0 flex-1">
          <ActivityStatusBadge status={activity.status} />
          <div className="mt-1.5 text-base font-semibold">{activity.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title={intl.formatMessage({ id: "assistant.close", defaultMessage: "Close" })}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="scroll-fade-y w-[42%] shrink-0 overflow-y-auto border-r border-border/40 p-2">
          <div className="heading-section px-3 pb-1 pt-1">{agentLabel}</div>
          {timeline}
        </div>
        <div className="scroll-fade-y min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {selectedStep ? <StepDetail step={selectedStep} onBack={() => setSelectedStepId(null)} /> : summary}
        </div>
      </div>

      {!byMain && composer}
    </>
  )
}

interface TimelineProps {
  steps: ActivityStep[]
  running: boolean
  selectedId: string | null
  /** The phone's sheet: reading-size rows. */
  large?: boolean
  onSelect: (id: string) => void
}

function Timeline({ steps, running, selectedId, large, onSelect }: TimelineProps) {
  return (
    <ol>
      {!large && (
        <TimelineRow icon={<Circle className="h-2 w-2 fill-current text-muted-foreground/60" />} last={steps.length === 0 && !running}>
          <span className="text-sm text-muted-foreground">
            <FormattedMessage id="assistant.activity.started" defaultMessage="Started" />
          </span>
        </TimelineRow>
      )}
      {steps.map((s, i) => (
        <TimelineRow
          key={s.id}
          icon={<StepIcon status={s.status} large={large} />}
          last={i === steps.length - 1}
          selected={selectedId === s.id}
          large={large}
          onClick={() => onSelect(s.id)}
        >
          <span
            className={cn(
              large ? "text-base font-medium leading-snug" : "text-sm",
              s.status === "failed" ? "text-status-error" : "text-foreground/90",
            )}
          >
            {s.label}
          </span>
        </TimelineRow>
      ))}
    </ol>
  )
}

interface TimelineRowProps {
  icon: React.ReactNode
  last: boolean
  selected?: boolean
  large?: boolean
  onClick?: () => void
  children: React.ReactNode
}

function TimelineRow({ icon, last, selected, large, onClick, children }: TimelineRowProps) {
  const body = (
    <>
      <span className={cn("mt-0.5 flex shrink-0 items-center justify-center", large ? "size-5" : "h-4 w-4")}>{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {large && onClick && <ChevronRight className="mt-0.5 size-5 shrink-0 text-muted-foreground/60" />}
    </>
  )
  return (
    <li className="relative">
      {/* The rail from this step's icon down to the next one. */}
      {!last && (
        <span
          className={cn(
            "pointer-events-none absolute bottom-0 w-px bg-border/60",
            large ? "left-[21.5px] top-9 border-l border-dashed border-border/60 bg-transparent" : "left-[19px] top-7",
          )}
        />
      )}
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "relative flex w-full text-left transition-colors",
            large ? "gap-3 rounded-xl px-3 py-2.5 active:bg-secondary-active" : "gap-3 rounded-lg px-3 py-2",
            selected ? "bg-foreground/[0.07]" : "hover:bg-secondary-hover",
          )}
        >
          {body}
        </button>
      ) : (
        <div className="relative flex gap-3 px-3 py-2">{body}</div>
      )}
    </li>
  )
}

function StepDetail({ step, onBack }: { step: ActivityStep; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        <FormattedMessage id="assistant.activity.summary" defaultMessage="Summary" />
      </button>

      <div>
        <div className="text-sm font-semibold">{step.label}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <StepIcon status={step.status} />
          <FormattedMessage {...ACTIVITY_STATUS_MESSAGES[step.status === "failed" ? "failed" : step.status === "running" ? "running" : "done"]} />
          <span className="text-muted-foreground/50">·</span>
          {formatClock(step.at)}
        </div>
      </div>

      <Section label={<FormattedMessage id="assistant.step.tool" defaultMessage="Tool" />}>
        <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{step.tool}</code>
      </Section>

      {step.args && (
        <Section label={<FormattedMessage id="assistant.step.input" defaultMessage="Input" />}>
          <CodeBlock>{JSON.stringify(step.args, null, 2)}</CodeBlock>
        </Section>
      )}

      <Section label={<FormattedMessage id="assistant.step.output" defaultMessage="Output" />}>
        {step.result ? (
          <CodeBlock tone={step.status === "failed" ? "error" : undefined}>{step.result}</CodeBlock>
        ) : (
          <div className="text-xs text-muted-foreground">
            {step.status === "running" ? (
              <FormattedMessage id="assistant.step.waiting" defaultMessage="Waiting for the result…" />
            ) : (
              <FormattedMessage id="assistant.step.noOutput" defaultMessage="No output." />
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

function Section({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-muted-foreground/80">{label}</div>
      {children}
    </div>
  )
}

function CodeBlock({ children, tone }: { children: string; tone?: "error" }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-[11px] leading-relaxed",
        tone === "error"
          ? "border-status-error/15 bg-status-error/10 text-status-error"
          : "border-border/40 bg-background/40 text-muted-foreground",
      )}
    >
      {children}
    </pre>
  )
}

function StepIcon({ status, large }: { status: ActivityStep["status"]; large?: boolean }) {
  const size = large ? "size-5" : "h-3.5 w-3.5"
  if (status === "running") return <Loader2 className={cn(size, "animate-spin text-muted-foreground")} />
  if (status === "failed") return <XCircle className={cn(size, "text-status-error")} />
  return <CheckCircle2 className={cn(size, large ? "text-status-ok" : "text-muted-foreground")} />
}
