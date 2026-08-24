/**
 * A local address the user has actually opened in the in-app browser. We
 * record these on navigation instead of scanning every listening port (which
 * surfaced unrelated processes like ControlCenter / QQ). The browser landing
 * lists this history and probes each entry for liveness.
 *
 * Persisted in localStorage; loopback hosts only, one card per host:port.
 */
export interface LocalServerEntry {
  /** Full URL last opened for this origin, e.g. "http://localhost:5173/dash". */
  url: string
  /** Hostname, e.g. "localhost". */
  host: string
  /** Port number. */
  port: number
  /** Best-known page <title>; falls back to "host:port". */
  title: string
  /** Epoch ms of the most recent visit. */
  lastOpenedAt: number
}

const STORAGE_KEY = "operon.browser.localServerHistory"
const MAX_ENTRIES = 50
/** Same-tab change signal (the `storage` event only fires in *other* tabs). */
const CHANGE_EVENT = "operon:local-server-history-changed"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** Identity for an entry — one card per host:port regardless of path. */
const keyOf = (host: string, port: number): string => `${host}:${port}`

const isLoopback = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")

const portOf = (parsed: URL): number =>
  parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80

const read = (): LocalServerEntry[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw == null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is LocalServerEntry =>
        typeof e === "object" &&
        e != null &&
        typeof (e as LocalServerEntry).url === "string" &&
        typeof (e as LocalServerEntry).port === "number"
    )
  } catch {
    return []
  }
}

const write = (entries: LocalServerEntry[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // quota / privacy mode — non-fatal
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

/** Recorded servers, most-recently-opened first. */
export function getServerHistory(): LocalServerEntry[] {
  return read().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

/**
 * Record (or refresh) a visit. No-op for non-loopback URLs so the "Local"
 * landing stays local. `title` upserts once the page title becomes known;
 * a later call without a title keeps the previously stored one.
 */
export function recordServerVisit(rawUrl: string, title?: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return
  const host = parsed.hostname
  if (!isLoopback(host)) return

  const port = portOf(parsed)
  const key = keyOf(host, port)
  const entries = read()
  const existing = entries.find((e) => keyOf(e.host, e.port) === key)
  const cleanTitle = title?.trim()
  const next: LocalServerEntry = {
    url: rawUrl,
    host,
    port,
    title: cleanTitle || existing?.title || `${host}:${port}`,
    lastOpenedAt: Date.now(),
  }
  const updated = [next, ...entries.filter((e) => keyOf(e.host, e.port) !== key)]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, MAX_ENTRIES)
  write(updated)
}

/** Forget one server (host:port derived from `url`). */
export function removeServerHistory(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  const key = keyOf(parsed.hostname, portOf(parsed))
  write(read().filter((e) => keyOf(e.host, e.port) !== key))
}

/** Subscribe to history changes (same-tab custom event + cross-tab storage). */
export function subscribeServerHistory(callback: () => void): () => void {
  const onCustom = () => callback()
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback()
  }
  window.addEventListener(CHANGE_EVENT, onCustom)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom)
    window.removeEventListener("storage", onStorage)
  }
}
