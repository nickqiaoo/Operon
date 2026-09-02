import { useIntl } from "react-intl"
import type { PanelId } from "./types"
import { useNewTab } from "./tab-entries"
import { ShortcutBadge } from "./ShortcutBadge"

interface EmptyPanelStateProps {
  panelId: PanelId
}

/**
 * Shown when a panel has no tabs: instead of forcing the user to click "+"
 * first, surface the new-tab choices right here. Picking one opens the tab
 * directly (same logic as the "+" dropdown via {@link useNewTab}).
 *
 * A quiet list of rows — icon, then name — rather than cards: a panel that is
 * empty anyway shouldn't answer with a slab of bordered boxes, and this is the
 * same shape the "+" menu already has, so the two read as one idea.
 */
export function EmptyPanelState({ panelId }: EmptyPanelStateProps) {
  const intl = useIntl()
  const { rootPath, ordered, openEntry, reviewExists } = useNewTab(panelId)

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      <div className="w-full max-w-md">
        {ordered.map((entry) => {
          const Icon = entry.icon
          const disabled =
            (entry.requiresWorkspace && rootPath == null) ||
            (entry.type === "review" && reviewExists)
          return (
            <button
              key={entry.type}
              type="button"
              data-testid={`empty-panel-card-${entry.type}`}
              disabled={disabled}
              onClick={() => openEntry(entry)}
              className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent-hover active:bg-accent-active disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {intl.formatMessage(entry.label)}
              </span>
              <ShortcutBadge tabType={entry.type} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
