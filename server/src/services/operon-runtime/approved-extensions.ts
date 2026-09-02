import type { Harness } from 'operon-agents'

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
    } catch (error) {
      console.warn(`[operon.extensions] could not restore extension "${status.id}":`, error instanceof Error ? error.message : String(error))
    }
  }
}
