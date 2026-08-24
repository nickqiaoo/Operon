import { useState, type ReactNode } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { useTabsStore } from "@/stores/tabs-store"
import type { PanelId, Tab } from "./types"

type DragData =
  | { kind: "app-shell-tab"; tabId: string }
  | { kind: "app-shell-panel"; panelId: PanelId }

interface ActiveDrag {
  tab: Tab
  sourcePanel: PanelId
}

interface PanelTabsProviderProps {
  children: ReactNode
}

const PANELS: PanelId[] = ["right", "bottom"]

/**
 * Wraps the app shell in a single DndContext so tab drags can cross between
 * the right and bottom panels. Drop targets are individual tabs (for insert
 * before) and the panel droppable (for append).
 */
export function PanelTabsProvider({ children }: PanelTabsProviderProps) {
  const right = useTabsStore((s) => s.right)
  const bottom = useTabsStore((s) => s.bottom)
  const reorderTab = useTabsStore((s) => s.reorderTab)
  const transferTab = useTabsStore((s) => s.transferTab)

  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null)

  const sensors = useSensors(
    // Match Codex: a small movement threshold so clicks don't trigger drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  const findPanelOfTab = (tabId: string): PanelId | null => {
    for (const panel of PANELS) {
      const state = panel === "right" ? right : bottom
      if (state.tabs.some((t) => t.tabId === tabId)) return panel
    }
    return null
  }

  const indexOfTabInPanel = (panel: PanelId, tabId: string): number => {
    const state = panel === "right" ? right : bottom
    return state.tabs.findIndex((t) => t.tabId === tabId)
  }

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragData | undefined
    if (data?.kind !== "app-shell-tab") return
    const sourcePanel = findPanelOfTab(data.tabId)
    if (sourcePanel == null) return
    const tab =
      (sourcePanel === "right" ? right : bottom).tabs.find(
        (t) => t.tabId === data.tabId
      ) ?? null
    if (tab == null) return
    setActiveDrag({ tab, sourcePanel })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null)

    const activeData = event.active.data.current as DragData | undefined
    const overData = event.over?.data.current as DragData | undefined
    if (activeData?.kind !== "app-shell-tab") return
    if (overData == null) return // dropped outside any droppable

    const sourcePanel = findPanelOfTab(activeData.tabId)
    if (sourcePanel == null) return

    if (overData.kind === "app-shell-tab") {
      const targetPanel = findPanelOfTab(overData.tabId)
      if (targetPanel == null) return
      if (sourcePanel === targetPanel) {
        const fromIdx = indexOfTabInPanel(sourcePanel, activeData.tabId)
        const toIdx = indexOfTabInPanel(targetPanel, overData.tabId)
        if (fromIdx < 0 || toIdx < 0) return
        reorderTab(sourcePanel, fromIdx, toIdx)
      } else {
        const toIdx = indexOfTabInPanel(targetPanel, overData.tabId)
        transferTab(sourcePanel, targetPanel, activeData.tabId, toIdx)
      }
      return
    }

    if (overData.kind === "app-shell-panel") {
      if (sourcePanel === overData.panelId) return
      transferTab(sourcePanel, overData.panelId, activeData.tabId, null)
    }
  }

  const handleDragCancel = () => setActiveDrag(null)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeDrag != null ? (
          <div className="pointer-events-none inline-flex h-7 max-w-[200px] items-center gap-1.5 rounded-md border border-border/50 bg-background px-2 text-xs shadow-float">
            <span className="truncate">{activeDrag.tab.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
