import { cn } from "@/lib/utils"

/**
 * Placeholder block for content that hasn't arrived yet. Use it wherever a list
 * would otherwise render its empty state while the first fetch is still in
 * flight — on the web build that gap is long enough to read as "nothing here".
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted/60", className)}
      {...props}
    />
  )
}

export { Skeleton }
