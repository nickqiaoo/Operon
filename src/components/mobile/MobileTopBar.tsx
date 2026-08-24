import { ChevronDown } from "lucide-react"
import type { ReactNode } from "react"

interface MobileTopBarProps {
  projectName: string | null
  workspaceName: string | null
  onTapContext: () => void
  /** Right-aligned controls (e.g. the inbox bell) rendered outside the tap target. */
  right?: ReactNode
}

/**
 * Top context bar. Mirrors the desktop breadcrumb (`Project › Workspace`) but
 * the whole thing is a tap target that opens the project/workspace switcher —
 * the single place where mobile context is shown and changed. Carries a
 * safe-area inset so it clears the status bar / notch.
 */
export function MobileTopBar({ projectName, workspaceName, onTapContext, right }: MobileTopBarProps) {
  return (
    <header
      className="shrink-0 border-b border-border/50 bg-background/95 backdrop-blur"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex h-12 w-full items-center">
        <button
          type="button"
          onClick={onTapContext}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-4 text-left"
        >
          <span className="truncate text-sm font-semibold text-foreground/90">
            {projectName ?? "operon"}
          </span>
          {workspaceName && (
            <>
              <span className="text-muted-foreground/40">›</span>
              <span className="truncate rounded-md bg-muted/50 px-1.5 py-0.5 text-xs text-foreground/80">
                {workspaceName}
              </span>
            </>
          )}
          <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground/60" />
        </button>
        {right && <div className="flex shrink-0 items-center pl-1 pr-2">{right}</div>}
      </div>
    </header>
  )
}
