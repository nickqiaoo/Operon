import { useEffect } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'

type PermissionKind = 'accessibility' | 'screenRecording'

/** Only re-prompt after this long — one grant covers every later turn. */
const REPROMPT_INTERVAL_MS = 5 * 60 * 1000

/** Per-permission so a granted one never suppresses the other's prompt. */
const lastAlertedAt: Record<PermissionKind, number> = {
  accessibility: 0,
  screenRecording: 0,
}

const COPY: Record<PermissionKind, { title: string; description: string }> = {
  accessibility: {
    title: 'Computer Use needs Accessibility',
    description:
      'Operon needs Accessibility permission to read app windows and send clicks and keystrokes.',
  },
  screenRecording: {
    title: 'Computer Use cannot see the screen',
    description:
      'Operon needs Screen & System Audio Recording permission to take app screenshots and show the live preview.',
  },
}

/**
 * Ask the native engine which macOS grants it actually has and toast any that a
 * running, enabled Computer Use is missing — each with a deep link to the exact
 * System Settings pane.
 *
 * Silence was the original bug: a missing grant made screenshots and the live
 * preview vanish with no message anywhere. Accessibility is worse — without it
 * `get_app_state` returns no tree at all, so the agent just fails — yet it had
 * no user-facing prompt. The engine is the only honest reporter (TCC follows the
 * running binary, not Electron), hence `computerUseGetPermissions`.
 */
export async function alertMissingComputerUsePermissions(): Promise<void> {
  const status = await api.computerUseGetPermissions().catch(() => null)
  // Nothing honest to say if the engine is off/unreachable or the feature is off.
  if (!status || !status.enabled || !status.running) return

  const now = Date.now()
  const missing: PermissionKind[] = []
  if (!status.accessibility) missing.push('accessibility')
  if (!status.screenRecording) missing.push('screenRecording')

  for (const kind of missing) {
    if (now - lastAlertedAt[kind] < REPROMPT_INTERVAL_MS) continue
    lastAlertedAt[kind] = now
    const { title, description } = COPY[kind]
    toast.warning(title, {
      description,
      duration: 12_000,
      action: {
        label: 'Open Settings',
        onClick: () => {
          void api.computerUseOpenPermissionSettings(kind).catch(() => {
            toast.error('Could not open System Settings')
          })
        },
      },
    })
  }
}

/**
 * Mounted once at the app root. The native PiP tells us when it can never draw a
 * frame this session (a missing Screen Recording grant); we turn that into a
 * re-check of *all* grants, since a brand-new user is usually missing both and
 * only Screen Recording ever had a push signal.
 */
export function useComputerUsePermissionAlert(): void {
  useEffect(() => {
    const pip = window.electronAPI?.computerUsePIP
    if (!pip?.onBlocked) return

    return pip.onBlocked(({ reason }) => {
      if (reason !== 'screen-recording') return
      void alertMissingComputerUsePermissions()
    })
  }, [])
}
