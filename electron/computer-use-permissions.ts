/**
 * macOS grants for Computer Use, asked for by the app itself.
 *
 * The cua-driver daemon is spawned embedded, so macOS attributes it to this app
 * and it runs on this app's Accessibility and Screen Recording grants. Embedded
 * cua-driver never raises a consent dialog on its own, so the request has to be
 * made here, from the process macOS holds responsible.
 *
 * Each request only prompts while the grant is still undecided: that is the one
 * case where macOS shows its own dialog (which already links to Settings) and
 * adds the app to the list. Past that point the user has to flip the switch
 * themselves, so they go straight to the pane.
 */
import { desktopCapturer, shell, systemPreferences } from 'electron'
import {
  setComputerUseHostPermissions,
  type ComputerUsePermissionKind,
} from '../server/src/services/computer-use-lifecycle.js'

const SETTINGS_PANE: Record<ComputerUsePermissionKind, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

function status(): { accessibility: boolean; screenRecording: boolean } {
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
  }
}

async function request(permission: ComputerUsePermissionKind): Promise<void> {
  if (permission === 'accessibility') {
    // `true` raises the system prompt and registers the app in the list.
    if (!systemPreferences.isTrustedAccessibilityClient(true)) return
  } else if (systemPreferences.getMediaAccessStatus('screen') === 'not-determined') {
    // Electron has no direct request call for Screen Recording; a capture
    // attempt is what makes macOS prompt and list the app.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => {})
    return
  }
  await shell.openExternal(SETTINGS_PANE[permission])
}

export function registerComputerUsePermissions(): void {
  if (process.platform !== 'darwin') return
  setComputerUseHostPermissions({ status, request })
}
