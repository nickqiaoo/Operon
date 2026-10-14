import { ArrowUpRight, GitBranch } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { Button } from "@/components/ui/button"
import { ProviderIcon } from "@/components/editor/components/ModelSelectorPanel"
import { cn } from "@/lib/utils"
import type { Activity } from "./types"
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
function whereLabel(activity: Activity): string {
  const c = activity.coding!
  return c.projectName ? `${c.projectName} / ${c.workspaceName}` : c.workspaceName
}

interface CodingAgentCardProps {
  activity: Activity
  onOpen: (activity: Activity) => void
  compact?: boolean
}

/**
 * A coding agent the assistant started in one of the user's workspaces. One card per
 * conversation that updates in place — running, waiting for you, done — with the way
 * into the conversation itself, where the work and its controls are.
 */
export function CodingAgentCard({ activity, onOpen, compact }: CodingAgentCardProps) {
  const intl = useIntl()
  const c = activity.coding
  if (!c) return null
  const waiting = activity.status === "waiting"
  const settled = activity.status !== "running" && !waiting
  const model = c.model && c.model !== "default" ? c.model : undefined

  return (
    <div
      className={cn(
        "w-full space-y-3 rounded-xl border border-border/60 bg-popover p-4 shadow-card dark:border-border/35",
        !compact && "min-w-[360px]",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <ProviderIcon id={c.providerId} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{activity.title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">{whereLabel(activity)}</span>
            {c.branch && c.branch !== c.workspaceName && (
              <>
                <GitBranch className="ml-1 h-3 w-3 shrink-0" />
                <span className="truncate">{c.branch}</span>
              </>
            )}
            <span className="text-muted-foreground/50">·</span>
            <span className="shrink-0">{codingAgentName(c.providerId)}</span>
            {model && <span className="truncate text-muted-foreground/70">{model}</span>}
          </div>
        </div>
        <ActivityStatusBadge status={activity.status} />
      </div>

      {/* Answered right here when the requests came with them; otherwise in the conversation. */}
      {waiting && c.pending?.length ? (
        <CodingPendingInputs chatId={c.chatId} pending={c.pending} />
      ) : waiting && c.waitingFor ? (
        <div className="rounded-lg border border-status-warn/15 bg-status-warn/10 px-3 py-2 text-xs text-status-warn">
          <FormattedMessage id="assistant.coding.waitingFor" defaultMessage="Waiting for you: {what}" values={{ what: c.waitingFor }} />
        </div>
      ) : null}
      {settled && activity.summary && (
        <div className="line-clamp-2 text-xs text-muted-foreground">{activitySummary(intl, activity.summary)}</div>
      )}

      <div className="flex items-center gap-2">
        {c.diffStat && (
          <span className="text-[11px] text-muted-foreground">
            <FormattedMessage
              id="assistant.coding.changedFiles"
              defaultMessage="{count, plural, one {# file} other {# files}}"
              values={{ count: c.diffStat.files }}
            />{" "}
            <span className="text-status-ok">+{c.diffStat.additions}</span>{" "}
            <span className="text-status-error">−{c.diffStat.deletions}</span>
          </span>
        )}
        <Button size="sm" variant="secondary" className="ml-auto h-8 gap-1.5" onClick={() => onOpen(activity)}>
          <ArrowUpRight className="h-3.5 w-3.5" />
          {waiting && !c.pending?.length ? (
            <FormattedMessage id="assistant.coding.goAnswer" defaultMessage="Go to answer" />
          ) : (
            <FormattedMessage id="assistant.coding.openConversation" defaultMessage="Open conversation" />
          )}
        </Button>
      </div>
    </div>
  )
}

/** Under a reply about one of those conversations: a quiet way into it. */
export function CodingChip({ activity, onOpen }: { activity: Activity; onOpen: (activity: Activity) => void }) {
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
