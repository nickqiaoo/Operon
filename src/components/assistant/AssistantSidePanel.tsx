import { Clock, Fingerprint, List, Pencil, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"

export type SidePanelTab = "activity" | "audit" | "schedule" | "profile"

const TABS: { id: SidePanelTab; label: string; icon: typeof List }[] = [
  { id: "activity", label: "Activity", icon: List },
  { id: "audit", label: "Audit", icon: ShieldCheck },
  { id: "schedule", label: "Schedule", icon: Clock },
  { id: "profile", label: "Profile", icon: Fingerprint },
]

interface AssistantSidePanelProps {
  name: string
  /** How many workers are running or waiting on the user. */
  busyCount: number
  tab: SidePanelTab
  onTabChange: (tab: SidePanelTab) => void
  onEditIdentity: () => void
  children: React.ReactNode
}

/** Right rail: who the assistant is, then Activity / Audit / Schedule / Profile. */
export function AssistantSidePanel({ name, busyCount, tab, onTabChange, onEditIdentity, children }: AssistantSidePanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col items-center px-4 pb-4 pt-6">
        <div className="relative">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-muted to-secondary text-2xl font-semibold text-foreground/80 shadow-card">
            {name.slice(0, 1).toUpperCase()}
          </div>
          <button
            type="button"
            onClick={onEditIdentity}
            title="Edit identity"
            className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-popover text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground dark:border-border/35"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </div>
        <div className="mt-2.5 text-base font-semibold">{name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-full", busyCount > 0 ? "bg-accent-warm" : "bg-accent-green")} />
          {busyCount > 0 ? `Working on ${busyCount}` : "Idle"}
        </div>
      </div>

      <div className="mx-3 flex shrink-0 gap-0.5 rounded-lg bg-muted/50 p-0.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            onClick={() => onTabChange(id)}
            className={cn(
              "flex h-7 flex-1 items-center justify-center rounded-md transition-colors",
              tab === id ? "bg-background text-foreground shadow-tab" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
      <div className="px-5 pt-3 text-sm font-semibold">{TABS.find((t) => t.id === tab)?.label}</div>

      <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  )
}
