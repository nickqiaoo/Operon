// The APNs / FCM device token, remembered locally so that signing out can hand
// it back to the broker.
//
// Registration happens in `useNativePushNotifications`, but *un*registration has
// to be driven from `logout()` — and that hook cannot be imported from
// web-auth.ts, which it imports itself. Hence this module: it depends on
// neither, so both can use it.

const DEVICE_TOKEN_KEY = 'operon.push.device_token'
const BROKER = (import.meta.env.VITE_BROKER_URL ?? '').replace(/\/$/, '')

/** Sign-out should not hang on an unreachable broker. */
const UNREGISTER_TIMEOUT_MS = 3_000

export function rememberPushDeviceToken(token: string): void {
  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, token)
  } catch {
    // Private-mode / quota failures only cost the unregister below.
  }
}

/**
 * Tell the broker to stop sending this user's notifications to this phone.
 *
 * Must be awaited *before* the local session is cleared: the request is
 * authenticated by the access token the fetch interceptor attaches, and the
 * broker deletes by device token, so a request that goes out unauthenticated
 * (or not at all) leaves the row behind.
 *
 * Why this matters beyond tidiness: `push_devices` is keyed by device token and
 * re-homes to whoever registered last, so *switching* accounts already fixes
 * itself. Signing out and stopping there does not — without this the phone keeps
 * receiving the previous user's notifications indefinitely, and the body of one
 * carries the opening of the agent's reply onto the lock screen.
 */
export async function unregisterPushDevice(): Promise<void> {
  const token = localStorage.getItem(DEVICE_TOKEN_KEY)
  // Forget it locally either way — a stale token here is worse than none, and
  // the next launch re-registers.
  localStorage.removeItem(DEVICE_TOKEN_KEY)
  if (!token || !BROKER) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UNREGISTER_TIMEOUT_MS)
  try {
    await fetch(`${BROKER}/auth/push/devices`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
  } catch {
    // Offline sign-out still has to complete. The row survives until the device
    // registers again (which re-homes it) or the account is deleted.
  } finally {
    clearTimeout(timer)
  }
}
