import { useState } from "react"
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

/**
 * A page over every project, narrowed to one or not (null = all). Remembered per
 * page under `storageKey`; a remembered project that has since been removed
 * reads as all.
 */
export function useProjectFilter(storageKey: string): [number | null, (projectId: number | null) => void] {
  const projects = useProjectStore((s) => s.projects)
  const [projectId, setProjectId] = useState<number | null>(() => readFilter(storageKey))
  const filter = projectId != null && projects.some((p) => p.id === projectId) ? projectId : null
  const change = (next: number | null) => {
    setProjectId(next)
    try {
      if (next == null) window.localStorage.removeItem(storageKey)
      else window.localStorage.setItem(storageKey, String(next))
    } catch {
      // Storage unavailable: the filter just isn't remembered.
    }
  }
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
          "no-drag h-7 w-auto max-w-56 gap-1.5 border-border/40 bg-popover/45 text-xs text-muted-foreground shadow-none",
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
