import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { PageVisibleContext } from "@/lib/page-visibility"

interface KeepAliveViewProps {
  /** Opened at least once. Until then nothing is rendered. */
  mounted: boolean
  /** The view on screen. Inactive views are kept with `display: none`. */
  active: boolean
  /** On screen and not covered by a full-screen page; read below via `usePageVisible()`. */
  visible: boolean
  children: ReactNode
}

/**
 * One of the main views (Assistant, Inbox, Board, the workbench). It mounts the first time it is
 * opened and then stays mounted while another is up, so coming back finds it as it was left
 * (selected channel, scroll, filters, a chat still streaming).
 *
 * Not React's `<Activity>`: a hidden Activity tears down its effects, which would drop the live
 * subscriptions these views keep running in the background (chat streams, the assistant thread).
 */
export function KeepAliveView({ mounted, active, visible, children }: KeepAliveViewProps) {
  if (!mounted) return null
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", !active && "hidden")}>
      <PageVisibleContext value={visible}>{children}</PageVisibleContext>
    </div>
  )
}
