import { create } from "zustand"
import { persist } from "zustand/middleware"
import { acceleratorsEqual } from "@/lib/shortcuts/accelerator"
import { shortcutCommands } from "@/lib/shortcuts/commands"

/**
 * User overrides for the keyboard shortcuts. Only what differs from
 * {@link shortcutCommands} is stored — a command the user never touched follows
 * its default, so changing a default in code reaches everyone who hasn't
 * customised that one. An empty array is a real value: "unbound on purpose".
 */
interface ShortcutsState {
  overrides: Record<string, string[]>
  /** The bindings in effect for a command. */
  keysFor: (commandId: string) => string[]
  setKeys: (commandId: string, keys: string[]) => void
  addKey: (commandId: string, key: string) => void
  removeKey: (commandId: string, key: string) => void
  /** Drops the override so the command follows its default again. */
  resetCommand: (commandId: string) => void
  resetAll: () => void
}

const defaultsFor = (commandId: string): string[] =>
  shortcutCommands.find((c) => c.id === commandId)?.defaultKeys ?? []

export const useShortcutsStore = create<ShortcutsState>()(
  persist(
    (set, get) => ({
      overrides: {},

      keysFor: (commandId) => get().overrides[commandId] ?? defaultsFor(commandId),

      setKeys: (commandId, keys) =>
        set((s) => ({ overrides: { ...s.overrides, [commandId]: keys } })),

      addKey: (commandId, key) =>
        set((s) => {
          const current = s.overrides[commandId] ?? defaultsFor(commandId)
          if (current.some((k) => acceleratorsEqual(k, key))) return s
          return { overrides: { ...s.overrides, [commandId]: [...current, key] } }
        }),

      removeKey: (commandId, key) =>
        set((s) => {
          const current = s.overrides[commandId] ?? defaultsFor(commandId)
          return {
            overrides: {
              ...s.overrides,
              [commandId]: current.filter((k) => !acceleratorsEqual(k, key)),
            },
          }
        }),

      resetCommand: (commandId) =>
        set((s) => {
          const { [commandId]: _dropped, ...rest } = s.overrides
          return { overrides: rest }
        }),

      resetAll: () => set({ overrides: {} }),
    }),
    {
      name: "operon-shortcuts",
      partialize: (s) => ({ overrides: s.overrides }),
    }
  )
)

/** Bindings in effect, outside React. */
export const shortcutKeysFor = (commandId: string): string[] =>
  useShortcutsStore.getState().keysFor(commandId)

/**
 * Every other command already bound to `key`. Drives the conflict warning in
 * settings — we warn rather than block, because two commands can legitimately
 * share a key when their availability never overlaps (codex ships several).
 */
export function commandsBoundTo(key: string, exceptCommandId?: string): string[] {
  const state = useShortcutsStore.getState()
  return shortcutCommands
    .filter((c) => c.id !== exceptCommandId)
    .filter((c) => state.keysFor(c.id).some((k) => acceleratorsEqual(k, key)))
    .map((c) => c.id)
}
