/**
 * Insecure-context shim for `crypto.randomUUID`.
 *
 * `crypto.randomUUID()` — like `crypto.subtle` — only exists in a *secure
 * context* (HTTPS or localhost). The web build is frequently reached by LAN IP
 * over plain http (e.g. a phone opening the dev server), which is an insecure
 * origin where `crypto.randomUUID` is `undefined`, so every call throws and the
 * action silently dies (e.g. tapping an agent to start a chat does nothing).
 * `crypto.getRandomValues` *is* available on insecure origins, so we synthesize a
 * v4 UUID from it. No-op in secure contexts, where the native one is kept.
 */
export function ensureRandomUUID(): void {
  if (typeof crypto === "undefined") return
  if (typeof crypto.randomUUID === "function") return
  ;(crypto as { randomUUID?: () => string }).randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40 // version 4
    b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"))
    return (
      `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-` +
      `${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
    )
  }
}
