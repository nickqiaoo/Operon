import { useEffect, useState } from "react"
import { ArrowLeft, ArrowUp, CheckCircle2, Circle, Loader2, Square, X, XCircle } from "lucide-react"
import { MessageResponse } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Activity, ActivityStep } from "./types"
import { ActivityStatusBadge, formatClock } from "./shared"
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
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  // A different activity starts on its summary.
  useEffect(() => {
    setSelectedStepId(null)
  }, [activity.id])

  const live = activity.status === "running" || activity.status === "waiting"
  const selectedStep = activity.steps.find((s) => s.id === selectedStepId) ?? null
  const stacked = layout === "stacked"

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
      onSelect={(id) => setSelectedStepId((cur) => (cur === id ? null : id))}
    />
  )
  const summary = (
    <>
      <div className="mb-2 text-sm font-semibold">Summary</div>
      {activity.report ? (
        <MessageResponse className="text-sm">{activity.report}</MessageResponse>
      ) : (
        <div className="text-sm text-muted-foreground">{activity.summary}</div>
      )}
    </>
  )

  return (
    <>
      <div className={cn("flex items-start gap-3 border-b border-border/40 py-4", stacked ? "px-4" : "px-5")}>
        <div className="min-w-0 flex-1">
          <ActivityStatusBadge status={activity.status} />
          <div className="mt-1.5 text-base font-semibold">{activity.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Started {formatClock(activity.startedAt)}
            {activity.finishedAt && ` · finished ${formatClock(activity.finishedAt)}`}
            {activity.source === "heartbeat" && " · by heartbeat"}
            {activity.source === "schedule" && " · by schedule"}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {stacked ? (
        <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {selectedStep ? (
            <StepDetail step={selectedStep} onBack={() => setSelectedStepId(null)} />
          ) : (
            <>
              {summary}
              <div className="mb-1 mt-5 text-sm font-semibold">Steps</div>
              <div className="-mx-2">{timeline}</div>
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="scroll-fade-y w-[42%] shrink-0 overflow-y-auto border-r border-border/40 p-2">{timeline}</div>
          <div className="scroll-fade-y min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {selectedStep ? <StepDetail step={selectedStep} onBack={() => setSelectedStepId(null)} /> : summary}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border/40 px-4 py-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) submit()
          }}
          placeholder={live ? "Tell this task something…" : "Follow up on this task…"}
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
          title="Send"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        {live && (
          <Button size="sm" variant="ghost" className={cn("gap-1.5", stacked ? "h-9" : "h-8")} onClick={() => onStop(activity.id)}>
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        )}
      </div>
    </>
  )
}

interface TimelineProps {
  steps: ActivityStep[]
  running: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}

function Timeline({ steps, running, selectedId, onSelect }: TimelineProps) {
  return (
    <ol>
      <TimelineRow icon={<Circle className="h-2 w-2 fill-current text-muted-foreground/60" />} last={steps.length === 0 && !running}>
        <span className="text-sm text-muted-foreground">Started</span>
      </TimelineRow>
      {steps.map((s, i) => (
        <TimelineRow
          key={s.id}
          icon={<StepIcon status={s.status} />}
          last={i === steps.length - 1}
          selected={selectedId === s.id}
          onClick={() => onSelect(s.id)}
        >
          <span className={cn("text-sm", s.status === "failed" ? "text-status-error" : "text-foreground/90")}>{s.label}</span>
        </TimelineRow>
      ))}
    </ol>
  )
}

interface TimelineRowProps {
  icon: React.ReactNode
  last: boolean
  selected?: boolean
  onClick?: () => void
  children: React.ReactNode
}

function TimelineRow({ icon, last, selected, onClick, children }: TimelineRowProps) {
  const body = (
    <>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </>
  )
  return (
    <li className="relative">
      {/* The rail from this step's icon down to the next one. */}
      {!last && <span className="pointer-events-none absolute bottom-0 left-[19px] top-7 w-px bg-border/60" />}
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(
            "relative flex w-full gap-3 rounded-lg px-3 py-2 text-left transition-colors",
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
        Summary
      </button>

      <div>
        <div className="text-sm font-semibold">{step.label}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <StepIcon status={step.status} />
          {step.status === "failed" ? "Failed" : step.status === "running" ? "Running" : "Done"}
          <span className="text-muted-foreground/50">·</span>
          {formatClock(step.at)}
        </div>
      </div>

      <Section label="Tool">
        <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{step.tool}</code>
      </Section>

      {step.args && (
        <Section label="Input">
          <CodeBlock>{JSON.stringify(step.args, null, 2)}</CodeBlock>
        </Section>
      )}

      <Section label="Output">
        {step.result ? (
          <CodeBlock tone={step.status === "failed" ? "error" : undefined}>{step.result}</CodeBlock>
        ) : (
          <div className="text-xs text-muted-foreground">{step.status === "running" ? "Waiting for the result…" : "No output."}</div>
        )}
      </Section>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
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

function StepIcon({ status }: { status: ActivityStep["status"] }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-status-error" />
  return <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
}
