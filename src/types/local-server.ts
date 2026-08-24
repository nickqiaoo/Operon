/**
 * Liveness probe result for a single local server, computed in the main
 * process (Node `http.get`, no CORS limits). The renderer asks the main
 * process to probe a set of ports it already knows about — we no longer
 * enumerate every listening port (that surfaced unrelated processes like
 * ControlCenter / QQ). The list of servers comes from the user's browsing
 * history instead (see `serverHistory.ts`).
 */
export interface LocalServerProbe {
  /** Port that was probed. */
  port: number
  /** True when an HTTP request to the port succeeded. */
  online: boolean
  /** The page's <title> if one could be read, else "". */
  title: string
}
