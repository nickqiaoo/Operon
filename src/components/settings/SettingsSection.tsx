import type { ComponentType, ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The one card every Settings tab is built from (see CLAUDE.md "Settings 页签卡片").
 *
 * Header is icon + title + one-line description, with an optional `action` pinned
 * to the right (a status badge, a Refresh button). Body goes below with `space-y-4`.
 * Tabs used to hand-copy these classes, and the ones that didn't ended up as bare
 * rows on the canvas — which is why some tabs read as cards and others as a list.
 */
export function SettingsSection({
  icon: Icon,
  title,
  description,
  action,
  className,
  children,
}: {
  icon?: ComponentType<{ className?: string }>
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <section className={cn("space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5", className)}>
      <div className="flex items-start gap-3">
        {Icon && <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-sm font-semibold">{title}</div>
          {description && <div className="text-xs text-muted-foreground">{description}</div>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * A label/description on the left and a control on the right, for the toggle-and-
 * picker lists inside a SettingsSection. Consecutive rows divide themselves; put
 * them in a plain `<div>` so the first one doesn't draw a rule under the header.
 */
export function SettingsRow({
  title,
  description,
  control,
}: {
  title: ReactNode
  description?: ReactNode
  control: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-t border-border/40 py-3 first:border-t-0 first:pt-0 last:pb-0 dark:border-border/35">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}
