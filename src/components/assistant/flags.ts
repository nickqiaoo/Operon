/**
 * The Assistant isn't released yet (docs/assistant/status.md), so only dev builds
 * show it — plus test builds made with `VITE_ASSISTANT=1` (e.g. a TestFlight build).
 */
export const ASSISTANT_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ASSISTANT === "1"
