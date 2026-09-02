import { useEffect, useMemo, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Pencil, Plus, RotateCcw, Search, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  acceleratorFromEvent,
  acceleratorsEqual,
  formatAccelerator,
} from "@/lib/shortcuts/accelerator"
import {
  SHORTCUT_SECTIONS,
  shortcutCommands,
  type ShortcutCommand,
  type ShortcutSection,
} from "@/lib/shortcuts/commands"
import { commandsBoundTo, useShortcutsStore } from "@/stores/shortcuts-store"

const SECTION_LABEL: Record<ShortcutSection, React.ReactNode> = {
  tabs: <FormattedMessage id="settings.shortcuts.section.tabs" defaultMessage="Tabs" />,
  panels: <FormattedMessage id="settings.shortcuts.section.panels" defaultMessage="Panels" />,
}

/** Which binding a recorder is open on: a command, plus the key it replaces. */
interface Recording {
  commandId: string
  /** The existing binding being re-recorded; absent when adding a new one. */
  replacing?: string
}

/**
 * Settings → Keyboard shortcuts.
 *
 * A rendering of the command table: one row per command, each showing its
 * current bindings as editable chips. A command can hold several bindings (a
 * "+" adds one), which is why the chips are a list rather than a single value.
 */
export function KeyboardShortcutsSettings() {
  const intl = useIntl()
  const [query, setQuery] = useState("")
  const [recording, setRecording] = useState<Recording | null>(null)
  const overrides = useShortcutsStore((s) => s.overrides)
  const keysFor = useShortcutsStore((s) => s.keysFor)
  const setKeys = useShortcutsStore((s) => s.setKeys)
  const removeKey = useShortcutsStore((s) => s.removeKey)
  const resetAll = useShortcutsStore((s) => s.resetAll)

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (command: ShortcutCommand) => {
      if (needle.length === 0) return true
      const haystack = [
        intl.formatMessage(command.title),
        intl.formatMessage(command.description),
        ...keysFor(command.id).map(formatAccelerator),
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(needle)
    }
    return SHORTCUT_SECTIONS.map((section) => ({
      section,
      commands: shortcutCommands.filter((c) => c.section === section && matches(c)),
    })).filter((group) => group.commands.length > 0)
    // `overrides` is what makes a key-text search re-run after a rebind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, intl, keysFor, overrides])

  // While recording, the next keypress becomes the binding. Captured on the
  // window so it works wherever focus sits, and in the capture phase so the
  // app's own global shortcuts never see (and act on) the key being recorded.
  useEffect(() => {
    if (recording == null) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        setRecording(null)
        return
      }
      const accelerator = acceleratorFromEvent(event)
      if (accelerator == null) return
      event.preventDefault()
      event.stopPropagation()
      const current = useShortcutsStore.getState().keysFor(recording.commandId)
      const next =
        recording.replacing == null
          ? [...current, accelerator]
          : current.map((k) => (acceleratorsEqual(k, recording.replacing!) ? accelerator : k))
      // Re-recording the same keys twice shouldn't duplicate them.
      setKeys(
        recording.commandId,
        next.filter((k, i) => next.findIndex((o) => acceleratorsEqual(o, k)) === i)
      )
      setRecording(null)
    }
    window.addEventListener("keydown", handler, true)
    return () => window.removeEventListener("keydown", handler, true)
  }, [recording, setKeys])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.shortcuts.searchPlaceholder",
              defaultMessage: "Search shortcuts",
            })}
            className="h-8 border-border/50 pl-8 text-xs"
          />
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs"
          onClick={() => resetAll()}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.shortcuts.resetAll" defaultMessage="Reset all" />
        </Button>
      </div>

      {sections.map(({ section, commands }) => (
        <div
          key={section}
          className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5"
        >
          <div className="text-sm font-semibold">{SECTION_LABEL[section]}</div>
          <div className="divide-y divide-border/40">
            {commands.map((command) => {
              const keys = keysFor(command.id)
              return (
                <div
                  key={command.id}
                  data-testid={`shortcut-row-${command.id}`}
                  className="flex items-start gap-4 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{intl.formatMessage(command.title)}</div>
                    <div className="text-xs text-muted-foreground">
                      {intl.formatMessage(command.description)}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {keys.length === 0 && recording?.commandId !== command.id && (
                      <span className="text-xs text-muted-foreground/70">
                        <FormattedMessage
                          id="settings.shortcuts.unassigned"
                          defaultMessage="Unassigned"
                        />
                      </span>
                    )}
                    {keys.map((key) => (
                      <BindingRow
                        key={key}
                        label={formatAccelerator(key)}
                        conflicts={commandsBoundTo(key, command.id).length > 0}
                        recording={
                          recording?.commandId === command.id &&
                          recording.replacing != null &&
                          acceleratorsEqual(recording.replacing, key)
                        }
                        onEdit={() =>
                          setRecording({ commandId: command.id, replacing: key })
                        }
                        onRemove={() => removeKey(command.id, key)}
                      />
                    ))}
                    {recording?.commandId === command.id && recording.replacing == null && (
                      <BindingRow label={null} recording onEdit={() => {}} />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                      onClick={() => setRecording({ commandId: command.id })}
                    >
                      <Plus className="h-3 w-3" />
                      <FormattedMessage
                        id="settings.shortcuts.addBinding"
                        defaultMessage="Add"
                      />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {sections.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/40 p-8 text-center text-xs text-muted-foreground">
          <FormattedMessage
            id="settings.shortcuts.noMatches"
            defaultMessage="No shortcuts match that search."
          />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        <FormattedMessage
          id="settings.shortcuts.hint"
          defaultMessage="Two commands may share a key when they never apply at the same time; a highlighted binding is one that overlaps another command."
        />
      </p>
    </div>
  )
}

interface BindingRowProps {
  /** null while recording a brand-new binding. */
  label: string | null
  recording?: boolean
  conflicts?: boolean
  onEdit: () => void
  onRemove?: () => void
}

function BindingRow({ label, recording, conflicts, onEdit, onRemove }: BindingRowProps) {
  return (
    <div className="flex items-center gap-1">
      <kbd
        className={cn(
          "rounded-md px-1.5 py-0.5 font-sans text-[11px] leading-4",
          recording
            ? "bg-status-info/10 text-status-info"
            : conflicts
              ? "bg-status-warn/10 text-status-warn"
              : "bg-muted text-muted-foreground"
        )}
      >
        {recording ? (
          <FormattedMessage
            id="settings.shortcuts.pressKeys"
            defaultMessage="Press a shortcut…"
          />
        ) : (
          label
        )}
      </kbd>
      <button
        type="button"
        onClick={onEdit}
        aria-label="Edit shortcut"
        className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent-hover hover:text-foreground"
      >
        <Pencil className="h-3 w-3" />
      </button>
      {onRemove != null && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove shortcut"
          className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent-hover hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
