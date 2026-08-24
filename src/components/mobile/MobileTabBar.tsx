import { FileDiff, LayoutDashboard, MessageSquare, Menu } from "lucide-react"
import { defineMessages, useIntl } from "react-intl"
import { cn } from "@/lib/utils"

export type MobileTab = "chats" | "channel" | "changes" | "more"

const TAB_LABELS = defineMessages({
  chats: { id: "mobile.tab.chats", defaultMessage: "Chats" },
  channel: { id: "mobile.tab.channel", defaultMessage: "Board" },
  changes: { id: "mobile.tab.changes", defaultMessage: "Changes" },
  more: { id: "mobile.tab.more", defaultMessage: "More" },
})

const TABS: { id: MobileTab; Icon: typeof MessageSquare }[] = [
  { id: "chats", Icon: MessageSquare },
  { id: "channel", Icon: LayoutDashboard },
  { id: "changes", Icon: FileDiff },
  { id: "more", Icon: Menu },
]

interface MobileTabBarProps {
  active: MobileTab
  onChange: (tab: MobileTab) => void
}

/**
 * Bottom navigation — the phone equivalent of the desktop left sidebar's
 * parallel destinations. Carries a safe-area inset so it clears the home
 * indicator on notched devices.
 */
export function MobileTabBar({ active, onChange }: MobileTabBarProps) {
  const intl = useIntl()
  return (
    <nav
      className="flex shrink-0 items-stretch border-t border-border/50 bg-background/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {TABS.map(({ id, Icon }) => {
        const isActive = id === active
        const label = intl.formatMessage(TAB_LABELS[id])
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-label={label}
            title={label}
            className={cn(
              "flex h-12 flex-1 items-center justify-center py-1 transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground/60 hover:text-muted-foreground"
            )}
          >
            <span
              className={cn(
                "grid size-9 place-items-center rounded-full transition-[background-color,color,opacity]",
                isActive ? "bg-muted/80" : "hover:bg-muted/45"
              )}
            >
              <Icon className={cn("size-5", isActive ? "opacity-100" : "opacity-70")} />
            </span>
          </button>
        )
      })}
    </nav>
  )
}
