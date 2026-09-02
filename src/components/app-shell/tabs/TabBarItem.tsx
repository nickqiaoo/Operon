import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  FileDiff,
  FolderTree,
  GitPullRequest,
  MessageSquarePlus,
  Globe,
  SquareTerminal,
  Workflow as WorkflowIcon,
  X,
  type LucideIcon,
} from "lucide-react"
import { useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import type { Tab, TabPayload } from "./types"

interface TabBarItemProps {
  tab: Tab
  isActive: boolean
  onActivate: () => void
  onClose: () => void
}

function getTabIcon(payload: TabPayload): LucideIcon {
  switch (payload.type) {
    case "terminal":
      return SquareTerminal
    case "browser":
      return Globe
    case "workspace-browser":
      return FolderTree
    case "review":
      return GitPullRequest
    case "side-chat":
      return MessageSquarePlus
    case "diff":
      return FileDiff
    case "workflow":
      return WorkflowIcon
    case "placeholder":
      return SquareTerminal
  }
}

export function TabBarItem({ tab, isActive, onActivate, onClose }: TabBarItemProps) {
  const intl = useIntl()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tab.tabId,
    data: { kind: "app-shell-tab" as const, tabId: tab.tabId },
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  const handleCloseClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    onClose()
  }

  // Pointer down on close should not start drag. Stopping propagation
  // prevents dnd-kit's sensor from activating.
  const handleClosePointerDown = (event: React.PointerEvent) => {
    event.stopPropagation()
  }

  const Icon = getTabIcon(tab.payload)

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onActivate}
      data-testid="panel-tab"
      data-active={isActive}
      data-dragging={isDragging}
      className={cn(
        "group inline-flex h-7 max-w-50 shrink-0 cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-[13px] transition-colors",
        isActive
          ? "bg-foreground/4 text-foreground shadow-tab dark:bg-white/6"
          : "text-muted-foreground hover:bg-foreground/3 hover:text-foreground dark:hover:bg-white/4",
        isDragging && "opacity-50"
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {/* Ellipsis, not a fade: a gradient that eats the last 14px of every title
          — long or short — reads as a rendering fault, not as "there's more". */}
      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      {/* Always visible, in its own slot right of the title. Hiding it until
          hover left the tab with a hole on its right at rest — the slot has to
          hold width either way, so an empty one just reads as bad spacing. The
          icon stays put: swapping it for the close button (the old behaviour)
          left you unable to tell what the tab was while pointing at it. */}
      {tab.isClosable ? (
        <button
          type="button"
          onClick={handleCloseClick}
          onPointerDown={handleClosePointerDown}
          aria-label={intl.formatMessage({ id: "appShell.closeTab", defaultMessage: "Close tab" })}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-foreground/8 hover:text-foreground dark:hover:bg-white/10"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="w-1.5 shrink-0" aria-hidden />
      )}
    </div>
  )
}
