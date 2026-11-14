import { createFilePeerRepo, peers, peersOptionsFromSettings, sharedLabelVisibility } from 'operon-agents-peers'

/**
 * The Teams extension — operon's build of `operon-agents-peers`, published as a file extension.
 *
 * It IS the framework's `peers()` definition and depends on nothing of this app, so it loads on any
 * operon-agents host. Its teammate types and budget are its own settings: the manifest declares
 * `PEERS_SETTINGS_SCHEMA` (written in, with Operon's default types, by
 * `scripts/build-peers-extension.mjs`), the framework stores and validates the value, and the host
 * edits it with its generic settings form. A change reloads the extension, which re-runs this
 * function. What a teammate is born as — its prompt, title and model (the lead's unless its type
 * names one) — is `peers()`'s own default; the host adds its workspace setup and the teammate's
 * chat row itself, for every session (`resolveSession` / `onSessionOpened`).
 *
 * Roster cards and the mailbox ledger live in `host.dataDir` — the extension's data folder,
 * outside the bundle — so an update of this file keeps the teams.
 */
export default peers((host) => {
  if (host.dataDir === undefined) throw new Error('Teams needs an extension data dir (extensionDir on the harness)')
  return {
    repo: createFilePeerRepo(host.dataDir),
    visibility: sharedLabelVisibility,
    limits: { maxOutboundPerTurn: 20, mailboxCapacity: 200 },
    team: { type: 'lead', description: 'Coordinates the team from the user’s conversation' },
    ...peersOptionsFromSettings(host.settings),
  }
})
