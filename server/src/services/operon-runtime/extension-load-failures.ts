/**
 * Why an approved extension is not running.
 *
 * The loader reports `error` only for a folder it can reject before importing (bad manifest,
 * missing entry, engine newer than this build). An import that THROWS is different: the approval
 * still stands, so the entry sits at `approved` and the only trace is a console line. That is the
 * shape an app update creates — a bundle compiled against the previous framework meeting the new
 * one — and what the user sees is that Teams quietly stopped existing.
 *
 * `syncApprovedExtensions` repairs most of those from the marketplace. This holds the remainder,
 * so the Extensions list can say why something is approved and yet not there.
 *
 * In memory on purpose: it describes THIS process against the bundle currently on disk. A restart
 * re-derives it by attempting the load again, and every install / load / remove clears it.
 */

/** What the marketplace pass could offer after a failed import. */
export type ExtensionRepairOutcome =
  /** The marketplace has no build newer than what is installed — nothing to try yet. */
  | 'unavailable'
  /** The marketplace could not be reached, so no fix was even looked for. */
  | 'unreachable'
  /** A newer build was offered and it did not fix this — the download or its import failed. */
  | 'failed'

export interface ExtensionLoadFailure {
  /** The import error, as thrown. */
  readonly message: string
  readonly repair?: ExtensionRepairOutcome
}

const failures = new Map<string, ExtensionLoadFailure>()

/** Remember that importing `id` failed. Replaces anything recorded before, repair included. */
export function recordLoadFailure(id: string, error: unknown, repair?: ExtensionRepairOutcome): void {
  const message = error instanceof Error ? error.message : String(error)
  failures.set(id, repair ? { message, repair } : { message })
}

/** Annotate an existing failure with what the marketplace pass found. No-op without one. */
export function recordRepairOutcome(id: string, repair: ExtensionRepairOutcome): void {
  const current = failures.get(id)
  if (current) failures.set(id, { ...current, repair })
}

/** Forget the failure — the extension loaded, or the bytes it described are gone. */
export function clearLoadFailure(id: string): void {
  failures.delete(id)
}

export function loadFailure(id: string): ExtensionLoadFailure | undefined {
  return failures.get(id)
}
