import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export function SettingsSection({
  title,
  description,
  action,
  className,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <section className={cn("settings-section space-y-4", className)}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="mb-1 text-sm font-semibold">{title}</h2>
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
