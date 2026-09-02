import { formatAccelerator } from "@/lib/shortcuts/accelerator"
import { commandIdForTabType, defaultKeysFor } from "@/lib/shortcuts/commands"
import { useShortcutsStore } from "@/stores/shortcuts-store"
import { cn } from "@/lib/utils"
import type { TabType } from "./types"

interface ShortcutBadgeProps {
  tabType: TabType
  className?: string
}

const NO_KEYS: string[] = []

/**
 * The key hint next to a new-tab entry. Reads the live binding rather than a
 * hard-coded string, so a shortcut rebound in Settings prints its new keys
 * here. Renders nothing for an entry with no command, or one left unbound.
 */
export function ShortcutBadge({ tabType, className }: ShortcutBadgeProps) {
  const commandId = commandIdForTabType(tabType)
  // Both branches return references the store already holds, so this selector
  // is identity-stable between unrelated store updates.
  const bindings = useShortcutsStore((s) =>
    commandId == null ? NO_KEYS : (s.overrides[commandId] ?? defaultKeysFor(commandId))
  )

  const first = bindings[0]
  if (first == null) return null

  return (
    <kbd
      className={cn(
        "shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-sans text-[11px] leading-4 text-muted-foreground",
        className
      )}
    >
      {formatAccelerator(first)}
    </kbd>
  )
}
