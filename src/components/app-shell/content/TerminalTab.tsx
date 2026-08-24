import { useEffect, useMemo, useRef, useState } from "react"
import { FormattedMessage } from "react-intl"
import { terminalManager } from "@/components/terminal/TerminalManager"
import type { TerminalState } from "@/components/terminal/TerminalInstance"

interface TerminalTabProps {
  terminalId: string
  cwd: string
  isActive: boolean
  /** Logical launcher (e.g. "claude") to auto-run on first open. */
  launch?: string
}

/**
 * Bottom-panel terminal tab. The xterm instance + PTY live in terminalManager
 * so they survive React unmounts (panel close, tab switch, drag-transfer).
 * This component just owns:
 *
 *   1. lazy ensure(instanceId, cwd) on first render
 *   2. ResizeObserver → manager.setBounds(rect)
 *   3. isActive → manager.setVisible(true|false)
 *   4. status overlay subscribed via instance.subscribe
 */
export function TerminalTab({ terminalId, cwd, isActive, launch }: TerminalTabProps) {
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const instance = useMemo(
    () => terminalManager.ensure(terminalId, cwd.length > 0 ? cwd : undefined, launch),
    // cwd/launch only matter at create time; ignore later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminalId]
  )

  // Track placeholder bounds.
  useEffect(() => {
    const el = placeholderRef.current
    if (el == null) return

    const flush = () => {
      const rect = el.getBoundingClientRect()
      terminalManager.setBounds(terminalId, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
    }
    flush()

    const targets = new Set<Element>([el])
    const ancestor = el.closest<HTMLElement>("[data-app-shell-focus-area]")
    if (ancestor != null) targets.add(ancestor)

    const observer = new ResizeObserver(flush)
    for (const target of targets) observer.observe(target)
    window.addEventListener("resize", flush)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", flush)
    }
  }, [terminalId])

  // Drive visibility.
  useEffect(() => {
    terminalManager.setVisible(terminalId, isActive)
    return () => {
      terminalManager.setVisible(terminalId, false)
    }
  }, [terminalId, isActive])

  // Subscribe to status for the overlay.
  const [state, setState] = useState<TerminalState>(() => instance.getState())
  useEffect(() => {
    setState(instance.getState())
    return instance.subscribe(setState)
  }, [instance])

  const showOverlay =
    state.status !== "connected" && state.status !== "idle"

  return (
    <div className="relative h-full w-full bg-background">
      <div ref={placeholderRef} className="h-full w-full" />
      {showOverlay && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/80 px-4 text-xs text-muted-foreground">
          <div className="font-mono text-[11px] uppercase tracking-widest">
            Terminal {state.status}
          </div>
          {state.statusDetail != null && (
            <div className="max-w-md text-center text-foreground">
              {state.statusDetail}
            </div>
          )}
          {state.status === "connecting" && (
            <div className="animate-pulse"><FormattedMessage id="terminal.initializing" defaultMessage="Initializing shell…" /></div>
          )}
        </div>
      )}
    </div>
  )
}
