import path from 'node:path'
import type { UIMessage } from 'ai'
import { RewindService, CheckpointStore } from '../rewind/index.js'

/** Maximum rewind points kept per chat; older ones are pruned on each capture. */
const MAX_CHECKPOINTS_PER_CHAT = 10

/**
 * Chats with a turn in flight, keyed by workspace.
 *
 * A checkpoint's [start, end] interval only attributes changes to its own chat
 * while that chat is the workspace's sole writer. When two chats run at once,
 * each one's end snapshot also captures whatever the other wrote meanwhile, so
 * both intervals become unreliable and every turn involved is flagged. Rewind
 * then asks before touching those files instead of overwriting them silently.
 *
 * In-memory on purpose: a restart ends every turn it was tracking, and turns
 * that never recorded an end snapshot are already treated as unbounded.
 */
const activeTurns = new Map<string, Map<number, { overlapped: boolean }>>()

/** Register a turn as running and flag it — plus everyone already running — on overlap. */
function beginTurn(cwd: string, chatId: number): void {
  // A turn that crashed before its end capture never deregistered. Starting a
  // new one proves the old is over, so drop the chat's stale entries first —
  // including under a workspace it has since moved away from. Otherwise the
  // chat would look permanently active and flag every later turn as concurrent.
  for (const [workspace, chats] of activeTurns) {
    if (!chats.delete(chatId)) continue
    if (chats.size === 0) activeTurns.delete(workspace)
  }

  let inWorkspace = activeTurns.get(cwd)
  if (!inWorkspace) {
    inWorkspace = new Map()
    activeTurns.set(cwd, inWorkspace)
  }
  const concurrent = inWorkspace.size > 0
  if (concurrent) {
    for (const state of inWorkspace.values()) state.overlapped = true
  }
  inWorkspace.set(chatId, { overlapped: concurrent })
}

/** Deregister a turn; returns whether another chat wrote to the workspace during it. */
function endTurn(cwd: string, chatId: number): boolean {
  const inWorkspace = activeTurns.get(cwd)
  const state = inWorkspace?.get(chatId)
  inWorkspace?.delete(chatId)
  if (inWorkspace && inWorkspace.size === 0) activeTurns.delete(cwd)
  return state?.overlapped ?? false
}

/**
 * Snapshot the workspace before the turn runs. Returns the messageUid the
 * checkpoint was filed under, so the caller can close the interval with
 * {@link captureTurnEndSnapshot} once the turn finishes; null when no
 * checkpoint was taken.
 */
export const captureCheckpointIfNeeded = async (params: {
  chatId: number
  cwd: string
  rawMessages: UIMessage[]
  skipSnapshot?: boolean
}): Promise<string | null> => {
  if (params.skipSnapshot) return null

  const lastUserMessage = params.rawMessages.filter((message) => message.role === 'user').pop()
  if (!lastUserMessage?.id) return null

  try {
    const snapshotId = await RewindService.capture(params.cwd)
    if (!snapshotId) return null

    // One checkpoint per turn (no dedup): the per-turn diff card needs each
    // turn's start snapshot to diff against its end. Turns that changed nothing
    // simply produce an empty diff and render no card.
    beginTurn(params.cwd, params.chatId)
    CheckpointStore.save(params.chatId, lastUserMessage.id, { snapshotId, createdAt: Date.now() })
    // Pin this snapshot so `git gc` can't reclaim it while it's a live rewind point.
    await RewindService.protectSnapshot(params.cwd, params.chatId, lastUserMessage.id, snapshotId)

    // Keep only the most recent N rewind points per chat; unpin + reclaim the rest.
    const evicted = CheckpointStore.prune(params.chatId, MAX_CHECKPOINTS_PER_CHAT)
    if (evicted.length > 0) {
      await RewindService.releaseSnapshots(params.cwd, params.chatId, evicted)
    }
    return lastUserMessage.id
  } catch (err) {
    console.error('[Rewind] Snapshot capture failed:', err)
    return null
  }
}

/**
 * Snapshot the workspace once the turn is done, closing that turn's diff
 * interval. Without it the newest turn has no upper bound and has to be diffed
 * against the live worktree — which makes reopening an old chat attribute every
 * later edit to that turn.
 *
 * Cheap: the sidecar index is already warm from the start capture, and a turn
 * that touched nothing short-circuits in `capture` and reuses the start hash.
 */
export const captureTurnEndSnapshot = async (params: {
  chatId: number
  cwd: string
  messageUid: string
}): Promise<void> => {
  try {
    const snapshotId = await RewindService.capture(params.cwd)
    // Deregister only once the snapshot is taken, so a chat that starts writing
    // while we capture still counts as concurrent with this turn.
    const overlapped = endTurn(params.cwd, params.chatId)
    if (!snapshotId) return
    CheckpointStore.setEnd(params.chatId, params.messageUid, snapshotId, overlapped)
    await RewindService.protectSnapshot(params.cwd, params.chatId, params.messageUid, snapshotId, 'end')
  } catch (err) {
    console.error('[Rewind] Turn-end snapshot capture failed:', err)
  } finally {
    // Idempotent: covers the early return and the failure path above, so a chat
    // never stays registered as running.
    endTurn(params.cwd, params.chatId)
  }
}

/** Why a file was left out of the revert. */
export type RewindSkipReason =
  /** Its content changed after this chat last wrote it. */
  | 'modified-by-others'
  /** Another chat wrote to the workspace during the turn that produced it. */
  | 'concurrent-turn'
  /** Its turn never recorded an end snapshot, so its changes cannot be bounded. */
  | 'unbounded-turn'

export interface RewindSkippedFile {
  /** Project-relative path. */
  path: string
  reason: RewindSkipReason
}

export interface RewindResult {
  success: boolean
  message?: string
  /** Absolute paths that were reverted. */
  filesChanged?: string[]
  /** Files left untouched; re-run with `force` to revert them anyway. */
  skipped?: RewindSkippedFile[]
  backupSnapshotId?: string
}

export interface RewindOptions {
  /** Revert the previously skipped files too — the user confirmed the overwrite. */
  force?: boolean
}

/**
 * Rewind the workspace to the checkpoint filed under `messageUid`.
 *
 * Only files this chat changed from that turn onward are touched, and only
 * while they still hold what this chat left there. Everything else is reported
 * in `skipped` for the caller to confirm; passing `force` reverts those too.
 */
export async function rewindToCheckpoint(
  chatId: number,
  messageUid: string,
  cwd: string,
  options?: RewindOptions,
): Promise<RewindResult> {
  const trimmedUid = messageUid.trim()
  if (!trimmedUid) {
    return { success: false, message: 'Missing messageUid argument' }
  }

  const entry = CheckpointStore.get(chatId, trimmedUid)
  if (!entry) {
    return { success: false, message: 'No checkpoint found for this message' }
  }

  try {
    const force = options?.force === true
    const { plan, verifyAgainst, uncertain } = await planRewind(chatId, trimmedUid, cwd)
    const targets = force ? plan : new Map([...plan].filter(([file]) => !uncertain.has(file)))

    const result = await RewindService.revert(cwd, entry.snapshotId, {
      plan: targets,
      // Under force the user already accepted every overwrite, so the content
      // check would only re-skip what they just confirmed.
      verifyAgainst: force ? undefined : verifyAgainst,
      force,
    })
    if (!result.success) {
      return { success: false, message: result.error ?? 'Revert failed' }
    }

    const skipped: RewindSkippedFile[] = force
      ? []
      : [...result.skipped, ...[...uncertain].map(([path, reason]) => ({ path, reason }))]

    return {
      success: true,
      message: `Reverted ${result.filesChanged.length} file(s)`,
      filesChanged: result.filesChanged,
      skipped,
      backupSnapshotId: result.backupSnapshotId,
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Rewind failed'
    console.error('[Rewind] rewindToCheckpoint failed:', err)
    return { success: false, message: errorMessage }
  }
}

export function listCheckpoints(chatId: number): Record<string, CheckpointStore.CheckpointEntry> {
  return CheckpointStore.list(chatId)
}

/**
 * How long after a turn started we still trust the live worktree to stand in
 * for a missing end snapshot. Only reachable when the end capture never ran —
 * a checkpoint written before end snapshots existed, or a process that died
 * mid-turn. Inside the window the worktree is a fair approximation of what the
 * turn just did; beyond it, it's whatever the repo has drifted to since, which
 * is exactly the attribution bug end snapshots exist to fix.
 */
const WORKTREE_FALLBACK_WINDOW_MS = 5 * 60 * 1000

interface TurnPoint {
  messageUid: string
  snapshotId: string
  endSnapshotId?: string
  /** Another chat wrote to the workspace while this turn ran. */
  overlapped?: boolean
  createdAt: number
}

type TurnEnd =
  /** Diff against a recorded snapshot — tree-to-tree, stable forever. */
  | { kind: 'snapshot'; snapshotId: string }
  /** Diff against the live worktree. */
  | { kind: 'worktree' }
  /** No trustworthy upper bound; the turn's diff is unknowable. */
  | { kind: 'none' }

/** Turns ordered oldest → newest, the order every interval calculation assumes. */
function orderTurns(chatId: number): TurnPoint[] {
  return Object.entries(CheckpointStore.list(chatId))
    .map(([messageUid, entry]) => ({
      messageUid,
      snapshotId: entry.snapshotId,
      endSnapshotId: entry.endSnapshotId,
      overlapped: entry.overlapped,
      createdAt: entry.createdAt,
    }))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Where turn `index`'s diff interval closes.
 *
 * The turn's own end snapshot when we have one — that excludes edits made
 * between turns, and never changes afterwards. Failing that, the next turn's
 * start snapshot still bounds it (coarser: it sweeps in anything edited while
 * the chat sat idle). Only a turn with neither falls back to the worktree, and
 * only briefly — see {@link WORKTREE_FALLBACK_WINDOW_MS}.
 */
function resolveTurnEnd(ordered: TurnPoint[], index: number, now: number): TurnEnd {
  const base = ordered[index]
  if (base.endSnapshotId) return { kind: 'snapshot', snapshotId: base.endSnapshotId }

  const next = ordered[index + 1]
  if (next) return { kind: 'snapshot', snapshotId: next.snapshotId }

  return now - base.createdAt <= WORKTREE_FALLBACK_WINDOW_MS ? { kind: 'worktree' } : { kind: 'none' }
}

interface RewindPlan {
  /** Project-relative path → the tree its content is restored from. */
  plan: Map<string, string>
  /** Project-relative path → the tree holding what this chat last left there. */
  verifyAgainst: Map<string, string>
  /** Paths whose attribution to this chat cannot be trusted, and why. */
  uncertain: Map<string, Exclude<RewindSkipReason, 'modified-by-others'>>
}

/**
 * Which files a rewind to `messageUid` should restore, and from where.
 *
 * Walks this chat's own turns and diffs each one tree to tree. Both endpoints
 * are frozen snapshots, so a file another chat edited *between* this chat's
 * turns never enters the plan at all — that is the whole point of not diffing
 * against the live worktree.
 *
 * Inside a turn the interval is only as honest as the workspace was quiet:
 * a turn that ran alongside another chat, or that never closed with an end
 * snapshot, may have swept up edits that were not this chat's. Those files stay
 * in the plan but are marked uncertain, so the caller can ask before touching
 * them rather than either dropping them or overwriting blindly.
 *
 * Each file is restored from the turn where this chat *first* touched it (so a
 * rewind spanning several turns undoes all of them), and verified against the
 * turn where it *last* touched it (the newest state it can claim authorship of).
 */
async function planRewind(chatId: number, messageUid: string, cwd: string): Promise<RewindPlan> {
  const plan = new Map<string, string>()
  const verifyAgainst = new Map<string, string>()
  const uncertain = new Map<string, Exclude<RewindSkipReason, 'modified-by-others'>>()

  const ordered = orderTurns(chatId)
  const from = ordered.findIndex((turn) => turn.messageUid === messageUid)
  if (from < 0) return { plan, verifyAgainst, uncertain }

  const now = Date.now()
  for (let index = from; index < ordered.length; index++) {
    const turn = ordered[index]
    const end = resolveTurnEnd(ordered, index, now)
    if (end.kind === 'none') continue

    const files = end.kind === 'snapshot'
      ? await RewindService.filesBetweenTrees(cwd, turn.snapshotId, end.snapshotId)
      : (await RewindService.changedFiles(cwd, turn.snapshotId)).map((file) => file.path)

    for (const file of files) {
      if (!plan.has(file)) plan.set(file, turn.snapshotId)
      if (end.kind === 'snapshot') {
        verifyAgainst.set(file, end.snapshotId)
        if (turn.overlapped) uncertain.set(file, 'concurrent-turn')
      } else {
        // Bounded by the live worktree, which by definition includes whatever
        // every other chat has done since. Never silently revert those.
        uncertain.set(file, 'unbounded-turn')
      }
    }
  }
  return { plan, verifyAgainst, uncertain }
}

export interface TurnFileDiffs {
  /** Snapshot the turn's changes are measured from (its start checkpoint). */
  snapshotId: string | null
  files: RewindService.TurnFileDiff[]
}

/**
 * All per-file unified diffs for a single turn, in one call — for the review
 * panel's "Last turn" scope. `messageUid` selects which turn (defaults to the
 * most recent). The diff spans that turn's start snapshot → its end snapshot;
 * see {@link resolveTurnEnd} for how the upper bound is picked.
 */
export async function getTurnFileDiffs(
  chatId: number,
  cwd: string,
  messageUid?: string,
): Promise<TurnFileDiffs> {
  const ordered = orderTurns(chatId)
  if (ordered.length === 0) return { snapshotId: null, files: [] }

  let index = messageUid ? ordered.findIndex((o) => o.messageUid === messageUid) : -1
  if (index < 0) index = ordered.length - 1 // default to / fall back to the latest turn

  const base = ordered[index]
  const end = resolveTurnEnd(ordered, index, Date.now())
  if (end.kind === 'none') return { snapshotId: base.snapshotId, files: [] }

  const files = end.kind === 'snapshot'
    ? await RewindService.turnFileDiffsBetween(cwd, base.snapshotId, end.snapshotId)
    : await RewindService.turnFileDiffs(cwd, base.snapshotId)
  return { snapshotId: base.snapshotId, files }
}

export interface TurnDiffEntry {
  messageUid: string
  snapshotId: string
  files: RewindService.TurnFileChange[]
}

/**
 * Per-turn file diffs for a chat: for each checkpoint, the changes between that
 * turn's start and end snapshots (see {@link resolveTurnEnd}). Only turns that
 * actually changed files are returned, so a turn we can't bound produces no
 * card rather than a misattributed one.
 */
export async function getTurnDiffs(chatId: number, cwd: string): Promise<{ turns: TurnDiffEntry[] }> {
  const ordered = orderTurns(chatId)
  const now = Date.now()

  const turns: TurnDiffEntry[] = []
  for (let i = 0; i < ordered.length; i++) {
    const base = ordered[i]
    const end = resolveTurnEnd(ordered, i, now)
    if (end.kind === 'none') continue

    const files = end.kind === 'snapshot'
      ? await RewindService.changedFilesBetween(cwd, base.snapshotId, end.snapshotId)
      : await RewindService.changedFiles(cwd, base.snapshotId)
    if (files.length > 0) {
      turns.push({ messageUid: base.messageUid, snapshotId: base.snapshotId, files })
    }
  }
  return { turns }
}

/**
 * Put back what a rewind took away.
 *
 * `files` are the paths that rewind reported changing; restoring just those
 * leaves every other chat's edits — made before or since — alone. Without them
 * this falls back to rewriting the whole worktree, which does not.
 */
export async function undoRewind(
  backupSnapshotId: string,
  cwd: string,
  files?: readonly string[]
): Promise<{ success: boolean; message?: string }> {
  if (!backupSnapshotId || !cwd) {
    return { success: false, message: 'Missing backupSnapshotId or cwd' }
  }

  try {
    if (files && files.length > 0) {
      // Rewind reports absolute paths; the snapshot repo speaks project-relative
      // ones, with forward slashes on every platform.
      const relative = files.map((file) =>
        (path.isAbsolute(file) ? path.relative(cwd, file) : file).replaceAll('\\', '/')
      )
      await RewindService.restoreFiles(cwd, backupSnapshotId, relative)
    } else {
      await RewindService.restore(cwd, backupSnapshotId)
    }
    return { success: true, message: 'Undo rewind successful' }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Undo failed'
    console.error('[Rewind] Undo failed:', err)
    return { success: false, message: errorMessage }
  }
}
