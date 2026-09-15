// Is the user sitting at this machine's desktop app right now?
//
// The server has no window of its own — in the desktop build it runs inside the
// Electron main process, which does. Rather than importing electron here (the
// same server also runs headless on nodes with no display), the host registers
// a probe at startup. No probe registered = headless = nobody is at a desktop.
//
// Consumed by push-relay: a phone push for something the user can already see
// on the screen in front of them is noise.

type PresenceProbe = () => boolean

/** What `powerMonitor.getSystemIdleState` reports. */
export type SystemIdleState = 'active' | 'idle' | 'locked' | 'unknown'

/**
 * The desktop's answer to "is the user at this machine".
 *
 * Deliberately NOT "is our window focused". Someone who asked an agent to do
 * something and then switched to a terminal or a browser is still at the
 * computer; requiring focus sent their phone a push the moment they looked away.
 * Recent keyboard or mouse input anywhere, with the screen unlocked, is the
 * signal. The app window has to exist, though: with it closed, nothing on the
 * screen can show them the request.
 */
export function isUserAtDesktop(input: { windowOpen: boolean; idleState: SystemIdleState }): boolean {
  return input.windowOpen && input.idleState === 'active'
}

let probe: PresenceProbe | null = null

export function setDesktopPresenceProbe(next: PresenceProbe | null): void {
  probe = next
}

export function isDesktopUserPresent(): boolean {
  if (!probe) return false
  try {
    return probe()
  } catch {
    return false
  }
}
