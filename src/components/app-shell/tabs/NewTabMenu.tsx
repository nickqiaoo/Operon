import { Plus } from "lucide-react"
import { useIntl } from "react-intl"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { PanelId } from "./types"
import { useNewTab } from "./tab-entries"
import { ShortcutBadge } from "./ShortcutBadge"

interface NewTabMenuProps {
  panelId: PanelId
}

export function NewTabMenu({ panelId }: NewTabMenuProps) {
  const intl = useIntl()
  const { rootPath, ordered, openEntry, reviewExists } = useNewTab(panelId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "tab.newTab", defaultMessage: "New tab" })}
          data-testid={`new-tab-trigger-${panelId}`}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52 border-border/40 shadow-float"
      >
        {ordered.map((entry) => {
          const Icon = entry.icon
          const disabled =
            (entry.requiresWorkspace && rootPath == null) ||
            (entry.type === "review" && reviewExists)
          return (
            <DropdownMenuItem
              key={entry.type}
              data-testid={`new-tab-item-${entry.type}`}
              disabled={disabled}
              onSelect={() => openEntry(entry)}
              className="gap-2 text-xs"
            >
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{intl.formatMessage(entry.label)}</span>
              <ShortcutBadge tabType={entry.type} />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
