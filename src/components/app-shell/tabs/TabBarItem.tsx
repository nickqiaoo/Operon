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
        "group inline-flex h-7 max-w-50 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg py-1 pl-1 pr-3 text-xs transition-all",
        isActive
          ? "bg-foreground/4 text-foreground shadow-tab dark:bg-white/6"
          : "text-muted-foreground hover:bg-foreground/3 hover:text-foreground dark:hover:bg-white/4",
        isDragging && "opacity-50"
      )}
    >
      {/* Icon ↔ close button live in the same slot; they cross-fade on hover. */}
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        <Icon
          className={cn(
            "h-3.5 w-3.5 transition-opacity duration-150",
            tab.isClosable && "group-hover:opacity-0"
          )}
          aria-hidden
        />
        {tab.isClosable && (
          <button
            type="button"
            onClick={handleCloseClick}
            onPointerDown={handleClosePointerDown}
            aria-label={intl.formatMessage({ id: "appShell.closeTab", defaultMessage: "Close tab" })}
            className={cn(
              "absolute inset-0 flex items-center justify-center rounded-full",
              "bg-foreground/80 text-background opacity-0 transition-opacity duration-150",
              "group-hover:opacity-100 hover:bg-foreground"
            )}
          >
            <X className="h-3 w-3" strokeWidth={2.5} />
          </button>
        )}
      </span>
      {/* Right-side fade mask instead of ellipsis. */}
      <span
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        style={{
          maskImage:
            "linear-gradient(to right, black calc(100% - 14px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, black calc(100% - 14px), transparent 100%)",
        }}
      >
        {tab.title}
      </span>
    </div>
  )
}
