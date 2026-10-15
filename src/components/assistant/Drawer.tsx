import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

const TRANSITION_MS = 300

/**
 * Two-phase open/close for a drawer that shows `value`: `shown` keeps the last
 * value mounted through the slide-out, `active` flips a frame after mount so
 * the browser animates in from off-screen. Escape closes.
 */
export function useDrawer<T>(value: T | null, onClose: () => void): { shown: T | null; active: boolean } {
  const [shown, setShown] = useState<T | null>(value)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (value != null) {
      setShown(value)
      const id = requestAnimationFrame(() => setActive(true))
      return () => cancelAnimationFrame(id)
    }
    setActive(false)
    const id = setTimeout(() => setShown(null), TRANSITION_MS)
    return () => clearTimeout(id)
  }, [value])

  const open = value != null
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Already handled (a mention picker closing, a field cancelling): not ours.
      if (e.key === "Escape" && !e.defaultPrevented) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  return { shown, active }
}

/**
 * The panel itself, slid in over the right rail. Non-modal: the wrapper lets
 * clicks through, so the thread stays usable while it is open.
 */
export function DrawerShell({
  active,
  className,
  children,
}: {
  active: boolean
  /** Overrides, e.g. the width. */
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <div
        className={cn(
          "pointer-events-auto absolute right-0 top-0 flex h-full w-[640px] max-w-[92%] flex-col border-l border-border/50 bg-popover shadow-drawer dark:border-border/35",
          "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform",
          active ? "translate-x-0" : "translate-x-full",
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
