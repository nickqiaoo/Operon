import { useCallback, useEffect, useMemo, useState } from "react"
import type { OpenWithApp } from "@/types/open-with"

/** Persisted id of the app the user last opened with — drives every trigger icon. */
const PREFERRED_KEY = "operon-open-with-preferred"
/** Same-window sync channel (the native `storage` event only fires cross-window). */
const CHANGED_EVENT = "operon-open-with-changed"

const readPreferred = (): string | null => {
  try {
    return localStorage.getItem(PREFERRED_KEY)
  } catch {
    return null
  }
}

/**
 * Shared "Open with…" state. Loads the installed editor/terminal list (cached by
 * the main process), tracks the preferred app, and exposes `open(targetPath)`.
 *
 * Used by both the top-bar dropdown and the file-preview button so they stay in
 * sync: picking an app anywhere updates `preferredApp` everywhere (via a
 * same-window custom event + the cross-window `storage` event).
 *
 * macOS / Electron only — `available` is false elsewhere; callers should hide.
 */
export function useOpenWith() {
  const available =
    typeof window !== "undefined" && Boolean(window.electronAPI?.listOpenWith)
  const [apps, setApps] = useState<OpenWithApp[] | null>(null)
  const [preferredId, setPreferredId] = useState<string | null>(readPreferred)

  // Load the app list on mount so triggers can show the preferred icon at once.
  useEffect(() => {
    if (!available) return
    let cancelled = false
    window.electronAPI
      ?.listOpenWith()
      .then((list) => {
        if (!cancelled) setApps(list)
      })
      .catch(() => {
        if (!cancelled) setApps([])
      })
    return () => {
      cancelled = true
    }
  }, [available])

  // Keep the preferred id in sync across every hook instance.
  useEffect(() => {
    const sync = () => setPreferredId(readPreferred())
    window.addEventListener("storage", sync)
    window.addEventListener(CHANGED_EVENT, sync)
    return () => {
      window.removeEventListener("storage", sync)
      window.removeEventListener(CHANGED_EVENT, sync)
    }
  }, [])

  const preferredApp = useMemo(() => {
    if (apps == null || apps.length === 0) return null
    return apps.find((a) => a.id === preferredId) ?? apps[0]
  }, [apps, preferredId])

  /** Remember `id` as preferred and notify the other instances. */
  const setPreferred = useCallback((id: string) => {
    setPreferredId(id)
    try {
      localStorage.setItem(PREFERRED_KEY, id)
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(CHANGED_EVENT))
  }, [])

  /**
   * Open `targetPath` (file or directory) with `app`, defaulting to the
   * preferred app. Opening also promotes `app` to preferred so the chosen
   * editor sticks — matching the dropdown's behaviour.
   */
  const open = useCallback(
    async (targetPath: string | null, app?: OpenWithApp) => {
      const target = app ?? preferredApp
      if (!target || !targetPath) return
      setPreferred(target.id)
      const result = await window.electronAPI?.openWith({
        appPath: target.appPath,
        targetPath,
        kind: target.kind,
      })
      if (result && !result.success) {
        console.error("[OpenWith] Failed:", result.error)
      }
    },
    [preferredApp, setPreferred]
  )

  return { available, apps, preferredApp, preferredId, setPreferred, open }
}
