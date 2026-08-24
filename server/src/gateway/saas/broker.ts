// The one broker this build talks to.
//
// Compiled in rather than persisted. The broker's address is a property of the
// release, not of the machine, so shipping a build is what moves everyone to a
// new broker — there is nothing on disk to reconcile, and no way for a machine
// to end up quietly pinned to a broker that has been retired.
// `~/.operon/saas.json` keeps only what genuinely IS per-machine: the node
// token and its ids.
//
// It lives here, in the main process, because that is where the embedded agent
// is started (see services/saas-runtime.ts). The settings page reads it back
// off /saas/status rather than holding a second copy, since two constants drift.
//
// Changing it invalidates every stored node token — a token is only valid at
// the broker that minted it. That is handled rather than ignored: the broker
// rejects the stale token, the agent stops instead of reconnecting forever, and
// the settings page asks the user to sign in again.
export const BROKER_URL = 'https://operon-api.chatcode.top'
