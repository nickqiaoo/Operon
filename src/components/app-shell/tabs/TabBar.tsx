import { useDroppable } from "@dnd-kit/core"
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable"
import { cn } from "@/lib/utils"
import { useTabsStore } from "@/stores/tabs-store"
import { useVisiblePanelTabs } from "./use-visible-tabs"
import { useState } from "react"
import { discardSideChat, sideChatHasMessages } from "@/lib/side-chat"
import { useAppShellStore } from "@/stores/app-shell-store"
import { CloseSideChatDialog } from "./CloseSideChatDialog"
import type { PanelId, Tab } from "./types"
import { TabBarItem } from "./TabBarItem"
import { NewTabMenu } from "./NewTabMenu"

interface TabBarProps {
  panelId: PanelId
  /** Right-side accessory area (e.g. panel-close button). */
  accessory?: React.ReactNode
  /**
   * Make the bar's empty space draggable as the OS title bar (macOS). Tabs and
   * buttons inside stay `no-drag` so they remain clickable. Only enable for a
   * bar pinned to the window's top edge (the right panel's strip).
   */
  dragRegion?: boolean
  className?: string
}

/**
 * Horizontal tab strip. Wraps tabs in a SortableContext (within-bar reorder)
 * and registers the whole strip as a droppable so cross-panel drags can land
 * here. The "+" button is a Radix DropdownMenu that lets the user pick which
 * kind of tab to open (NewTabMenu).
 */
export function TabBar({ panelId, accessory, dragRegion, className }: TabBarProps) {
  // Not `panel.tabs` — the browser is scoped to the active conversation, so the strip
  // shows only the pages in scope. See use-visible-tabs.ts.
  const { tabs, activeTabId } = useVisiblePanelTabs(panelId)
  const activateTab = useTabsStore((s) => s.activateTab)
  const closeTab = useTabsStore((s) => s.closeTab)

  const skipCloseConfirm = useAppShellStore((s) => s.skipSideChatCloseConfirm)
  const setSkipCloseConfirm = useAppShellStore((s) => s.setSkipSideChatCloseConfirm)
  const [pendingClose, setPendingClose] = useState<{ tabId: string; chatId: number } | null>(
    null
  )

  const { setNodeRef, isOver } = useDroppable({
    id: `panel-droppable-${panelId}`,
    data: { kind: "app-shell-panel" as const, panelId },
  })

  const tabIds = tabs.map((t) => t.tabId)

  const discard = (tabId: string, chatId: number) => {
    closeTab(panelId, tabId)
    discardSideChat(chatId)
  }

  // A side chat is temporary: closing its tab throws the conversation away
  // rather than leaving a row nothing can navigate back to. Confirm first when
  // there is something to lose — an untouched one closes straight away, and so
  // does any of them once the user has said not to ask.
  const handleClose = (tab: Tab) => {
    if (tab.payload.type !== "side-chat") {
      closeTab(panelId, tab.tabId)
      return
    }
    const { chatId } = tab.payload
    if (skipCloseConfirm) {
      discard(tab.tabId, chatId)
      return
    }
    void sideChatHasMessages(chatId).then((used) => {
      if (!used) {
        discard(tab.tabId, chatId)
        return
      }
      setPendingClose({ tabId: tab.tabId, chatId })
    })
  }

  return (
    <div
      ref={setNodeRef}
      data-app-shell-tab-bar={panelId}
      className={cn(
        // Canvas-coloured like EditorTabs: the bottom border already separates
        // the strip from the content, so a tint on top of it is a second
        // divider doing the same job — it just reads as a mismatched patch.
        "flex h-10 shrink-0 items-center gap-1 border-b border-border/50 bg-background px-2",
        // Drop-target feedback is an interaction state, so a fill is right here.
        isOver && "bg-muted/40",
        dragRegion && "drag-region",
        className
      )}
    >
      <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
        <div className="no-drag hide-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <TabBarItem
              key={tab.tabId}
              tab={tab}
              isActive={activeTabId === tab.tabId}
              onActivate={() => activateTab(panelId, tab.tabId)}
              onClose={() => handleClose(tab)}
            />
          ))}
        </div>
      </SortableContext>
      <div className="no-drag flex shrink-0 items-center">
        <NewTabMenu panelId={panelId} />
      </div>
      {accessory && (
        <div className="no-drag ml-auto flex shrink-0 items-center">{accessory}</div>
      )}
      <CloseSideChatDialog
        open={pendingClose != null}
        onCancel={() => setPendingClose(null)}
        onConfirm={(skipNextTime) => {
          if (skipNextTime) setSkipCloseConfirm(true)
          if (pendingClose) discard(pendingClose.tabId, pendingClose.chatId)
          setPendingClose(null)
        }}
      />
    </div>
  )
}
