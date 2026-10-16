import { ArrowUpRight, GitBranch } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { Button } from "@/components/ui/button"
import { ProviderIcon } from "@/components/editor/components/ModelSelectorPanel"
import { AgentAvatar } from "@/components/icons/AgentAvatar"
import { cn } from "@/lib/utils"
import type { ActivityCoding } from "@shared/assistant"
import type { ActivitySummary } from "./types"
import { ActivityStatusBadge } from "./shared"
import { activitySummary } from "./assistant-i18n"
import { CodingPendingInputs } from "./CodingPendingInputs"

/** Names of the agents the assistant can start in a workspace (server: SUPPORTED_EXTERNAL_AGENT_IDS). */
const AGENT_NAMES: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  kimi: "Kimi Code",
  cursor: "Cursor",
  grok: "Grok",
  copilot: "GitHub Copilot",
  antigravity: "Antigravity",
}

export function codingAgentName(providerId: string): string {
  return AGENT_NAMES[providerId] ?? providerId
}

/** `project / workspace`. */
function whereLabel(activity: ActivitySummary): string {
  const c = activity.coding!
  return c.projectName ? `${c.projectName} / ${c.workspaceName}` : c.workspaceName
}

interface CodingAgentCardProps {
  activity: ActivitySummary
  onOpen: (activity: ActivitySummary) => void
  compact?: boolean
}

/** The model and effort the user chose, quieter than the agent's name. */
function ModelLabel({ coding }: { coding: ActivityCoding }) {
  const model = coding.model && coding.model !== "default" ? coding.model : undefined
  return (
    <>
      {model && <span className="truncate text-muted-foreground/70">{model}</span>}
      {coding.effort && <span className="shrink-0 text-muted-foreground/70">{coding.effort}</span>}
    </>
  )
}

/** `project / workspace`, and the branch when it says something the workspace name doesn't. */
function WhereLabel({ activity }: { activity: ActivitySummary }) {
  const c = activity.coding!
  return (
    <>
      <span className="truncate">{whereLabel(activity)}</span>
      {c.branch && c.branch !== c.workspaceName && (
        <>
          <GitBranch className="ml-1 h-3 w-3 shrink-0" />
          <span className="truncate">{c.branch}</span>
        </>
      )}
    </>
  )
}

/** ` · 3 files +12 −4`: uncommitted changes when the last turn finished. */
function DiffStatLabel({ coding }: { coding: ActivityCoding }) {
  if (!coding.diffStat) return null
  return (
    <>
      <span className="text-muted-foreground/50">·</span>
      <span className="shrink-0">
        <FormattedMessage
          id="assistant.coding.changedFiles"
          defaultMessage="{count, plural, one {# file} other {# files}}"
          values={{ count: coding.diffStat.files }}
        />{" "}
        <span className="text-status-ok">+{coding.diffStat.additions}</span>{" "}
        <span className="text-status-error">−{coding.diffStat.deletions}</span>
      </span>
    </>
  )
}

/** What the conversation waits on: answered right here when the requests came with them; otherwise in the conversation. */
function CodingWaiting({ activity }: { activity: ActivitySummary }) {
  const c = activity.coding!
  if (activity.status !== "waiting") return null
  if (c.pending?.length) return <CodingPendingInputs chatId={c.chatId} pending={c.pending} />
  if (!c.waitingFor) return null
  return (
    <div className="rounded-lg border border-status-warn/15 bg-status-warn/10 px-3 py-2 text-xs text-status-warn">
      <FormattedMessage id="assistant.coding.waitingFor" defaultMessage="Waiting for you: {what}" values={{ what: c.waitingFor }} />
    </div>
  )
}

function useOpenLabel(activity: ActivitySummary): string {
  const intl = useIntl()
  return activity.status === "waiting" && !activity.coding?.pending?.length
    ? intl.formatMessage({ id: "assistant.coding.goAnswer", defaultMessage: "Go to answer" })
    : intl.formatMessage({ id: "assistant.coding.openConversation", defaultMessage: "Open conversation" })
}

/**
 * A coding agent the assistant started in one of the user's workspaces. One card per
 * conversation that updates in place — running, waiting for you, done — with the way
 * into the conversation itself, where the work and its controls are.
 */
export function CodingAgentCard({ activity, onOpen, compact }: CodingAgentCardProps) {
  const intl = useIntl()
  const openLabel = useOpenLabel(activity)
  const c = activity.coding
  if (!c) return null
  const settled = activity.status !== "running" && activity.status !== "waiting"

  return (
    <div
      className={cn(
        "w-full space-y-2.5 rounded-xl border border-border/60 bg-popover p-3 shadow-card dark:border-border/35",
        !compact && "min-w-[360px]",
      )}
    >
      {/* One row: who and where on the left, state and the way in on the right. */}
      <div className="flex items-center gap-3">
        <AgentAvatar provider={c.providerId} size="md" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{activity.title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <WhereLabel activity={activity} />
            <span className="text-muted-foreground/50">·</span>
            <span className="shrink-0">{codingAgentName(c.providerId)}</span>
            <ModelLabel coding={c} />
            <DiffStatLabel coding={c} />
          </div>
        </div>
        <span className="flex shrink-0">
          <ActivityStatusBadge status={activity.status} />
        </span>
        {/* Phone: just the arrow, the row is too narrow for a label beside the title. */}
        <Button
          size="sm"
          variant="secondary"
          className={cn("h-8 shrink-0 gap-1.5", compact && "w-8 px-0")}
          onClick={() => onOpen(activity)}
          title={compact ? openLabel : undefined}
          aria-label={openLabel}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          {!compact && openLabel}
        </Button>
      </div>

      <CodingWaiting activity={activity} />
      {settled && activity.summary && (
        <div className="line-clamp-2 pl-11 text-xs text-muted-foreground">{activitySummary(intl, activity.summary)}</div>
      )}
    </div>
  )
}

/**
 * The coding agent behind an Activity, at the top of its detail: who runs it and where, what it
 * changed, the way into its conversation, and what it is waiting on. The title and state are
 * already in the detail's header.
 */
export function CodingOverview({ activity, onOpen, large }: { activity: ActivitySummary; onOpen: (activity: ActivitySummary) => void; large?: boolean }) {
  const openLabel = useOpenLabel(activity)
  const c = activity.coding
  if (!c) return null
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-background/40 p-3 dark:border-border/35">
        <AgentAvatar provider={c.providerId} size="md" />
        <div className="min-w-0 flex-1">
          <div className={cn("flex min-w-0 items-center gap-1.5 font-medium", large ? "text-base" : "text-sm")}>
            <span className="shrink-0">{codingAgentName(c.providerId)}</span>
            <span className="flex min-w-0 items-center gap-1 font-normal">
              <ModelLabel coding={c} />
            </span>
          </div>
          <div className={cn("mt-0.5 flex min-w-0 items-center gap-1 text-muted-foreground", large ? "text-sm" : "text-xs")}>
            <WhereLabel activity={activity} />
            <DiffStatLabel coding={c} />
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className={cn("shrink-0 gap-1.5", large ? "h-9" : "h-8")}
          onClick={() => onOpen(activity)}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          {openLabel}
        </Button>
      </div>
      <CodingWaiting activity={activity} />
    </div>
  )
}

/** Under a reply about one of those conversations: a quiet way into it. */
export function CodingChip({ activity, onOpen }: { activity: ActivitySummary; onOpen: (activity: ActivitySummary) => void }) {
  const intl = useIntl()
  const c = activity.coding
  if (!c) return null
  return (
    <button
      type="button"
      onClick={() => onOpen(activity)}
      title={intl.formatMessage({ id: "assistant.coding.openConversation", defaultMessage: "Open conversation" })}
      className="flex max-w-full items-center gap-1.5 self-start rounded-lg px-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
    >
      <ProviderIcon id={c.providerId} size={12} />
      <span className="truncate">
        {activity.title} · {whereLabel(activity)}
      </span>
      <ArrowUpRight className="h-3 w-3 shrink-0" />
    </button>
  )
}
