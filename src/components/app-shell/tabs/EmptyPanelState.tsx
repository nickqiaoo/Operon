import { useIntl } from "react-intl"
import { cn } from "@/lib/utils"
import type { PanelId } from "./types"
import { useNewTab } from "./tab-entries"

interface EmptyPanelStateProps {
  panelId: PanelId
}

/**
 * Shown when a panel has no tabs: instead of forcing the user to click "+"
 * first, surface the new-tab choices as big quick-pick cards. Picking one opens
 * the tab directly (same logic as the "+" dropdown via {@link useNewTab}).
 *
 * The right panel is tall+narrow, so cards stack in a column; the bottom panel
 * is wide+short, so they flow in a wrapping row.
 */
export function EmptyPanelState({ panelId }: EmptyPanelStateProps) {
  const intl = useIntl()
  const { rootPath, ordered, openEntry, reviewExists } = useNewTab(panelId)
  const isRow = panelId === "bottom"

  return (
    <div className="h-full overflow-auto">
      <div
        className={cn(
          "flex min-h-full items-center justify-center gap-2.5 p-5",
          isRow ? "flex-row flex-wrap" : "flex-col"
        )}
      >
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
              className={cn(
                "group flex flex-col items-center gap-2 rounded-xl border border-border/40 bg-muted/10 px-4 py-6 text-center transition-colors hover:border-border/60 hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border/40 disabled:hover:bg-muted/10",
                isRow ? "w-40" : "w-full max-w-sm"
              )}
            >
              <Icon className="h-5 w-5 text-muted-foreground transition-colors group-hover:text-foreground" />
              <div className="space-y-0.5">
                <div className="text-sm font-semibold text-foreground">
                  {intl.formatMessage(entry.label)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {intl.formatMessage(entry.description)}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
