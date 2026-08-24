import { getUserId } from '../web-auth'

// Long enough for a cold tunnel hop, short enough that a wedged broker doesn't
// leave the machine picker looking frozen.
const PROBE_TIMEOUT_MS = 8_000

/**
 * Does this machine demand a paired device before it will talk?
 *
 * The gate used to answer that from local state alone — "no key stored, so
 * pairing is required" — which is right for every desktop (packaged builds
 * hardcode `'required'`, see electron/main.ts) and wrong for a headless node
 * running with `OPERON_REMOTE_E2EE=off`. Such a node has no UI to show a
 * pairing QR or approve a device, so a client that insists on pairing first can
 * never reach it at all.
 *
 * `/api/health` is the probe because of where it sits: `createApiTokenMiddleware`
 * lets it through unauthenticated, while `createRemoteE2EEMiddleware` still runs
 * (server/src/app.ts). So one plain request separates the two policies — 426
 * means the node wants encryption, 200 means it doesn't.
 *
 * Everything else — offline node, 502 from the broker, timeout, no network — is
 * "don't know", and don't-know must mean "assume pairing". Reading it the other
 * way would let one bad moment drop a user into an unencrypted session with a
 * machine that never agreed to one.
 */
export async function nodeRequiresPairing(nodeId: string): Promise<boolean> {
  const broker = (import.meta.env.VITE_BROKER_URL ?? '').replace(/\/$/, '')
  const userId = getUserId()
  if (!broker || !userId) return true

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const url = `${broker}/u/${encodeURIComponent(userId)}/n/${encodeURIComponent(nodeId)}/api/health`
    const response = await fetch(url, { signal: controller.signal })
    return !response.ok
  } catch {
    return true
  } finally {
    window.clearTimeout(timer)
  }
}
