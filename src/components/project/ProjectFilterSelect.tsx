import { useCallback, useSyncExternalStore } from "react"
import { FormattedMessage } from "react-intl"
import { Folder } from "lucide-react"
import { cn } from "@/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useProjectStore } from "@/stores/project-store"

function readFilter(storageKey: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey)
    const id = raw == null ? NaN : Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

// Live value per key, shared by every hook on that key: the Channels page's
// header picks the project and the sidebar's channel list narrows with it.
const filterValues = new Map<string, number | null>()
const filterListeners = new Map<string, Set<() => void>>()

function currentFilter(storageKey: string): number | null {
  if (!filterValues.has(storageKey)) filterValues.set(storageKey, readFilter(storageKey))
  return filterValues.get(storageKey) ?? null
}

/**
 * A page over every project, narrowed to one or not (null = all). Remembered per
 * page under `storageKey` and shared by everything reading that key; a
 * remembered project that has since been removed reads as all.
 */
export function useProjectFilter(storageKey: string): [number | null, (projectId: number | null) => void] {
  const projects = useProjectStore((s) => s.projects)
  const subscribe = useCallback((listener: () => void) => {
    const listeners = filterListeners.get(storageKey) ?? new Set()
    filterListeners.set(storageKey, listeners)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [storageKey])
  const projectId = useSyncExternalStore(subscribe, () => currentFilter(storageKey))
  const filter = projectId != null && projects.some((p) => p.id === projectId) ? projectId : null
  const change = useCallback((next: number | null) => {
    filterValues.set(storageKey, next)
    try {
      if (next == null) window.localStorage.removeItem(storageKey)
      else window.localStorage.setItem(storageKey, String(next))
    } catch {
      // Storage unavailable: the filter just isn't remembered.
    }
    filterListeners.get(storageKey)?.forEach((listener) => listener())
  }, [storageKey])
  return [filter, change]
}

/** "All projects" or one of them; sits in a page header next to its other controls. */
export function ProjectFilterSelect({
  value,
  onChange,
  className,
}: {
  value: number | null
  onChange: (projectId: number | null) => void
  className?: string
}) {
  const projects = useProjectStore((s) => s.projects)
  return (
    <Select value={value == null ? "all" : String(value)} onValueChange={(v) => onChange(v === "all" ? null : Number(v))}>
      <SelectTrigger
        className={cn(
          "no-drag h-7 w-auto max-w-56 gap-1.5 border-0 bg-transparent text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent",
          className,
        )}
      >
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="end"
        sideOffset={6}
        className="border border-border/40 bg-popover/95 backdrop-blur-sm shadow-float"
      >
        <SelectItem value="all">
          <FormattedMessage id="board.allProjects" defaultMessage="All projects" />
        </SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={String(p.id)}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The Board and Channels pages' filter, also read by the sidebar's channel list. */
export const BOARD_PROJECT_FILTER_KEY = "operon.boardProjectFilter"
