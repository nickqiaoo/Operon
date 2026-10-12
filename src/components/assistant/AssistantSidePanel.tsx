import { Clock, Fingerprint, List, Pencil, ShieldCheck, X } from "lucide-react"
import { defineMessages, useIntl, type MessageDescriptor } from "react-intl"
import { cn } from "@/lib/utils"
import { busyLabel } from "./assistant-i18n"

export type SidePanelTab = "activity" | "audit" | "schedule" | "profile"

const TAB_LABELS = defineMessages({
  activity: { id: "assistant.tab.activity", defaultMessage: "Activity" },
  audit: { id: "assistant.tab.audit", defaultMessage: "Audit" },
  schedule: { id: "assistant.tab.schedule", defaultMessage: "Schedule" },
  profile: { id: "assistant.tab.profile", defaultMessage: "Profile" },
}) satisfies Record<SidePanelTab, MessageDescriptor>

const TABS: { id: SidePanelTab; icon: typeof List }[] = [
  { id: "activity", icon: List },
  { id: "audit", icon: ShieldCheck },
  { id: "schedule", icon: Clock },
  { id: "profile", icon: Fingerprint },
]

interface AssistantSidePanelProps {
  name: string
  /** How many workers are running or waiting on the user. */
  busyCount: number
  tab: SidePanelTab
  onTabChange: (tab: SidePanelTab) => void
  onEditIdentity: () => void
  /**
   * The phone's full-screen page: bigger throughout, a floating close button,
   * room for the status bar and home indicator, and no heading over the tab.
   */
  large?: boolean
  onClose?: () => void
  children: React.ReactNode
}

/** Right rail: who the assistant is, then Activity / Audit / Schedule / Profile. */
export function AssistantSidePanel({ name, busyCount, tab, onTabChange, onEditIdentity, large, onClose, children }: AssistantSidePanelProps) {
  const intl = useIntl()
  if (large) {
    return (
      <LargePanel name={name} busyCount={busyCount} tab={tab} onTabChange={onTabChange} onEditIdentity={onEditIdentity} onClose={onClose}>
        {children}
      </LargePanel>
    )
  }
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
            title={intl.formatMessage({ id: "assistant.editIdentity", defaultMessage: "Edit identity" })}
            className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-border/60 bg-popover text-muted-foreground transition-colors hover:bg-secondary-hover hover:text-foreground dark:border-border/35"
          >
            <Pencil className="h-3 w-3" />
          </button>
        </div>
        <div className="mt-2.5 text-base font-semibold">{name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-full", busyCount > 0 ? "bg-accent-warm" : "bg-accent-green")} />
          {busyLabel(intl, busyCount > 0)}
        </div>
      </div>

      <div className="mx-3 flex shrink-0 gap-0.5 rounded-lg bg-muted/50 p-0.5">
        {TABS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={intl.formatMessage(TAB_LABELS[id])}
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
      <div className="px-5 pt-3 text-sm font-semibold">{intl.formatMessage(TAB_LABELS[tab])}</div>

      <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  )
}

/** The phone's version: the same parts at the size of a page of its own. */
function LargePanel({ name, busyCount, tab, onTabChange, onEditIdentity, onClose, children }: Omit<AssistantSidePanelProps, "large">) {
  const intl = useIntl()
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={intl.formatMessage({ id: "assistant.close", defaultMessage: "Close" })}
          className="liquid-glass absolute left-4 z-10 flex size-11 items-center justify-center rounded-full text-foreground/80 transition-transform active:scale-[0.94]"
          style={{ top: "calc(env(safe-area-inset-top) + 0.5rem)" }}
        >
          <X className="size-5" />
        </button>
      )}

      <div className="flex flex-col items-center px-4 pb-5" style={{ paddingTop: "calc(env(safe-area-inset-top) + 1rem)" }}>
        <div className="relative">
          <div className="flex size-24 items-center justify-center rounded-full bg-gradient-to-br from-muted to-secondary text-4xl font-semibold text-foreground/80 shadow-card">
            {name.slice(0, 1).toUpperCase()}
          </div>
          <button
            type="button"
            onClick={onEditIdentity}
            aria-label={intl.formatMessage({ id: "assistant.editIdentity", defaultMessage: "Edit identity" })}
            className="liquid-glass absolute -bottom-0.5 -right-0.5 flex size-9 items-center justify-center rounded-full text-foreground/80 transition-transform active:scale-[0.94]"
          >
            <Pencil className="size-4" />
          </button>
        </div>
        <div className="mt-3 text-2xl font-bold">{name}</div>
        <div className="mt-1 flex items-center gap-2 text-[15px] text-muted-foreground">
          <span className={cn("size-2 rounded-full", busyCount > 0 ? "bg-accent-warm" : "bg-accent-green")} />
          {busyLabel(intl, busyCount > 0)}
        </div>
      </div>

      <div className="mx-4 flex h-14 shrink-0 gap-1 rounded-full border border-border/40 bg-muted/40 p-1 dark:border-border/35">
        {TABS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-label={intl.formatMessage(TAB_LABELS[id])}
            onClick={() => onTabChange(id)}
            className={cn(
              "flex flex-1 items-center justify-center rounded-full transition-colors",
              tab === id ? "bg-background text-foreground shadow-tab" : "text-muted-foreground active:text-foreground",
            )}
          >
            <Icon className="size-6" />
          </button>
        ))}
      </div>

      <div
        className="scroll-fade-y min-h-0 flex-1 overflow-y-auto pt-2"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {children}
      </div>
    </div>
  )
}
