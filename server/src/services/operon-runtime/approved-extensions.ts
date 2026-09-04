import type { Harness } from 'operon-agents'
import { installMarketplaceExtension, listMarketplaceExtensions } from './extension-marketplace.js'
import { clearLoadFailure, recordLoadFailure, recordRepairOutcome } from './extension-load-failures.js'

/**
 * Restore file extensions the user explicitly approved before. The loader only reports
 * `approved` when the entry file still has the exact mtime recorded by the approval; new or
 * changed marketplace downloads remain inert until the user chooses Load or Reload.
 */
export async function loadApprovedExtensions(harness: Harness): Promise<void> {
  const manager = harness.extensions
  if (!manager) return
  for (const status of await manager.list()) {
    if (status.state !== 'approved') continue
    try {
      await manager.load(status.id)
      clearLoadFailure(status.id)
    } catch (error) {
      // The approval survives a failed import, so the entry stays `approved` and nothing on it
      // says it is not running. Record the reason for the Extensions list; `syncApprovedExtensions`
      // may still repair it a moment later, and clears the record when it does.
      recordLoadFailure(status.id, error)
      console.warn(`[operon.extensions] could not restore extension "${status.id}":`, error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * Bring the user's extensions up to what the marketplace offers, once, in the background.
 *
 * An Operon update replaces the `operon-agents` build compiled into the app, and a marketplace
 * bundle is compiled against ONE framework version — so an app update can leave a bundle that
 * the new loader refuses to import (`loadApprovedExtensions` above records the reason and moves
 * on) while the build that fits is already published. Nobody should have to know that, so the
 * update finishes itself; what it cannot fix, it annotates so the Extensions list can say why.
 *
 * Deliberately narrow:
 * - Only ids the user already approved. This never installs something new.
 * - Only entries the marketplace reports as `update`, which already means "compatible with this
 *   build" — an entry this app cannot run is not in the list at all (`marketplaceEntryFor`).
 * - Offline, marketplace down, download corrupt, new bundle refuses to load: every one of these
 *   leaves what is on disk exactly as it was. The worst case is the state we are already in.
 *
 * Runs AFTER the harness is built, never on its critical path — it reaches the marketplace over
 * the network, and nothing here should be able to slow down or fail a launch.
 */
export async function syncApprovedExtensions(harness: Harness): Promise<void> {
  const manager = harness.extensions
  if (!manager) return
  // Both states are the user's approval: `loaded` is one that came back a moment ago, `approved`
  // one whose import just failed — the case this exists for.
  const trusted = (await manager.list()).filter((status) => status.state === 'loaded' || status.state === 'approved')
  if (trusted.length === 0) return

  let offered: Awaited<ReturnType<typeof listMarketplaceExtensions>>
  try {
    offered = await listMarketplaceExtensions()
  } catch (error) {
    // Being offline is not a problem in itself: nothing changed. It only matters for an extension
    // that failed to import, where it is the difference between "no fix exists" and "we could not
    // look" — so say which on those rows and stay quiet everywhere else.
    for (const status of trusted) recordRepairOutcome(status.id, 'unreachable')
    console.info(`[operon.extensions] skipped the update check: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  for (const status of trusted) {
    const entry = offered.extensions.find((candidate) => candidate.id === status.id && candidate.status === 'update')
    if (!entry) {
      // An entry this build cannot run is not in the list at all, so "no update offered" means
      // the marketplace has nothing newer that fits. For a working extension that is the normal
      // case; for one that failed to import it is the whole answer, and the row should say so.
      recordRepairOutcome(status.id, 'unavailable')
      continue
    }
    try {
      await installMarketplaceExtension(entry.id)
      // `load` on a live extension is a coordinated swap, so this is also the repair path for
      // one that failed to import at startup.
      await manager.load(entry.id)
      clearLoadFailure(entry.id)
      console.info(`[operon.extensions] updated "${entry.id}" to ${entry.version} (engine ${entry.engine})`)
    } catch (error) {
      recordLoadFailure(entry.id, error, 'failed')
      console.warn(`[operon.extensions] could not update extension "${entry.id}":`, error instanceof Error ? error.message : String(error))
    }
  }
}
