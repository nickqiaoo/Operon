import { useState } from "react"
import { ChevronDown, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AssistantGrant, AuditRecord } from "./types"
import { AuditIconTile, DECISION_LABEL, timeAgo } from "./shared"
import { Empty } from "./ActivityTab"

interface AuditTabProps {
  records: AuditRecord[]
  grants: AssistantGrant[]
  onRevoke: (grantId: string) => void
}

/**
 * Every permission decision a worker ran into — the user's answers on approval cards and
 * the ones made automatically (a site the user named, something always allowed). Newest
 * first. Standing "Always allow"s sit on top so they can be taken back.
 */
export function AuditTab({ records, grants, onRevoke }: AuditTabProps) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (records.length === 0 && grants.length === 0) {
    return <Empty text="No permission decisions yet. When a task needs your OK, it shows up here." />
  }

  return (
    <div className="px-2 pb-4 pt-1">
      {grants.length > 0 && (
        <>
          <div className="heading-section px-2 pb-1 pt-2">Always allowed</div>
          {grants.map((g) => (
            <div key={g.id} className="group flex items-center gap-3 rounded-lg px-2 py-1.5">
              <AuditIconTile icon={g.icon} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground/90">{g.title}</div>
                <div className="text-[11px] text-muted-foreground/70">Granted {timeAgo(g.grantedAt)}</div>
              </div>
              <button
                type="button"
                onClick={() => onRevoke(g.id)}
                title="Revoke"
                aria-label={`Revoke ${g.title}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-secondary-hover hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {records.length > 0 && <div className="heading-section px-2 pb-1 pt-3">History</div>}
        </>
      )}
      {records.map((r) => {
        const open = expanded === r.id
        return (
          <div key={r.id} className="rounded-lg px-2 py-2">
            <button
              type="button"
              onClick={() => setExpanded(open ? null : r.id)}
              className="flex w-full items-start gap-3 text-left"
            >
              <AuditIconTile icon={r.icon} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground/90">{r.title}</div>
                <div className="text-xs text-muted-foreground">{r.detail}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground/70">
                  <span className={cn(r.decision === "denied" && "text-status-error")}>{DECISION_LABEL[r.decision]}</span>
                  {" · "}
                  {timeAgo(r.at)}
                </div>
              </div>
              {r.args && (
                <ChevronDown
                  className={cn("mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
                />
              )}
            </button>
            {open && r.args && (
              <pre className="ml-11 mt-2 max-h-48 overflow-auto rounded-lg border border-border/40 bg-background/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
                {JSON.stringify(r.args, null, 2)}
              </pre>
            )}
          </div>
        )
      })}
    </div>
  )
}
