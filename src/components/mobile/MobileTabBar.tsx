import { FileDiff, LayoutDashboard, MessageSquare, Menu, Sparkles } from "lucide-react"
import { defineMessages, useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import { ASSISTANT_ENABLED } from "@/components/assistant/flags"

export type MobileTab = "chats" | "assistant" | "channel" | "changes" | "more"

/**
 * The tabs this build shows, in order. The native bars draw exactly these
 * (NativeShell.configure), so a tab hidden here is hidden there too.
 */
export const MOBILE_TABS: readonly MobileTab[] = ASSISTANT_ENABLED
  ? ["chats", "assistant", "channel", "changes", "more"]
  : ["chats", "channel", "changes", "more"]

export function isMobileTab(value: string): value is MobileTab {
  return (MOBILE_TABS as readonly string[]).includes(value)
}

/** Shared with the native iOS tab bar, which is titled from here so it follows the locale. */
export const MOBILE_TAB_LABELS = defineMessages({
  chats: { id: "mobile.tab.chats", defaultMessage: "Chats" },
  assistant: { id: "mobile.tab.assistant", defaultMessage: "Assistant" },
  channel: { id: "mobile.tab.channel", defaultMessage: "Board" },
  changes: { id: "mobile.tab.changes", defaultMessage: "Changes" },
  more: { id: "mobile.tab.more", defaultMessage: "More" },
})

const TAB_ICONS: Record<MobileTab, typeof MessageSquare> = {
  chats: MessageSquare,
  assistant: Sparkles,
  channel: LayoutDashboard,
  changes: FileDiff,
  more: Menu,
}

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
      {MOBILE_TABS.map((id) => {
        const Icon = TAB_ICONS[id]
        const isActive = id === active
        const label = intl.formatMessage(MOBILE_TAB_LABELS[id])
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
