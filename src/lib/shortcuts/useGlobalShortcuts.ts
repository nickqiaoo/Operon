import { useEffect } from "react"
import { matchesAccelerator } from "./accelerator"
import { shortcutCommands } from "./commands"
import { useShortcutsStore } from "@/stores/shortcuts-store"

/**
 * The app's single keydown listener. Walks the command table, and the first
 * command whose current binding matches — and that the context can actually run
 * — consumes the key.
 *
 * Availability is checked before `preventDefault`: a command that can't run
 * lets the key through to the browser/OS, which is what keeps ⌘W closing the
 * window when the focus isn't in a panel.
 */
export function useGlobalShortcuts(): void {
  // Subscribed so rebinding in settings takes effect without a reload.
  const overrides = useShortcutsStore((s) => s.overrides)

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Bindings all carry a modifier, so this only skips work, never matches.
      if (!event.metaKey && !event.ctrlKey && !event.altKey) return
      const { keysFor } = useShortcutsStore.getState()
      for (const command of shortcutCommands) {
        if (!keysFor(command.id).some((key) => matchesAccelerator(event, key))) continue
        // Two commands may share a key when their availability never overlaps,
        // so keep looking rather than giving up on the first unavailable one.
        if (command.isAvailable?.() === false) continue
        event.preventDefault()
        command.run()
        return
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [overrides])
}
