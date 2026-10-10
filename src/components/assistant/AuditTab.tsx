import { useState } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AuditRecord } from "./types"
import { AuditIconTile, DECISION_LABEL, timeAgo } from "./shared"
import { Empty } from "./ActivityTab"

interface AuditTabProps {
  records: AuditRecord[]
}

/**
 * Every permission decision a worker ran into that reached the assistant — the user's answers on
 * approval cards, a site the user named, a step skipped while nobody was watching. Newest first.
 * What an agent's own mode let through never reaches the assistant, so it is not listed here.
 */
export function AuditTab({ records }: AuditTabProps) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (records.length === 0) {
    return <Empty text="No permission decisions yet. When a task needs your OK, it shows up here." />
  }

  return (
    <div className="px-2 pb-4 pt-1">
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
