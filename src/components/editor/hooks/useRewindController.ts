import { useCallback, useState } from 'react'
import { api, type RewindSkippedFile } from '@/lib/api'
import { useProjectStore } from '@/stores/project-store'
import { trackEvent } from '@/lib/analytics'

type RewindedCheckpoint = {
  messageId: string
  backupSnapshotId: string
  /** Absolute paths the rewind changed, so undo puts back only those. */
  filesChanged: string[]
}

/**
 * Files the rewind refused to touch, held until the user decides.
 *
 * A rewind only reverts files this chat can still claim; anything another chat
 * changed comes back here instead of being overwritten. Confirming re-runs the
 * same rewind with `force`.
 */
type PendingConflicts = {
  messageId: string
  files: RewindSkippedFile[]
}

export function useRewindController({
  dbChatId,
}: {
  dbChatId?: number
}) {
  const [rewindDialogOpen, setRewindDialogOpen] = useState(false)
  const [rewindTargetMessageId, setRewindTargetMessageId] = useState<string | null>(null)
  const [rewindedCheckpoint, setRewindedCheckpoint] = useState<RewindedCheckpoint | null>(null)
  const [pendingConflicts, setPendingConflicts] = useState<PendingConflicts | null>(null)

  const handleRewindToCheckpoint = useCallback((userMessageId: string) => {
    setRewindTargetMessageId(userMessageId)
    setRewindDialogOpen(true)
  }, [])

  /** Runs one rewind pass and records what it changed; returns the files it skipped. */
  const runRewind = useCallback(
    async (messageId: string, force: boolean): Promise<RewindSkippedFile[]> => {
      if (dbChatId === undefined) return []

      const activeWorkspace = useProjectStore.getState().getActiveWorkspace()
      const cwd = activeWorkspace?.worktreePath ?? '.'
      const result = await api.aiRewindToCheckpoint(dbChatId, messageId, cwd, force)

      if (!result.success) {
        console.error('[Rewind] Failed:', result.message)
        return []
      }

      // The counterpart to `changes_committed`: the user threw the agent's work
      // away. Without both sides, a high turn count reads as engagement whether
      // the turns were useful or not.
      trackEvent('changes_rewound', {
        forced: force,
        files_changed: result.filesChanged?.length ?? 0,
      })

      if (result.backupSnapshotId) {
        setRewindedCheckpoint((previous) => ({
          messageId,
          // A forced second pass takes its own backup, but undo has to reach the
          // state from before the first pass — so keep the original.
          backupSnapshotId: previous?.messageId === messageId
            ? previous.backupSnapshotId
            : result.backupSnapshotId!,
          filesChanged: [
            ...(previous?.messageId === messageId ? previous.filesChanged : []),
            ...(result.filesChanged ?? []),
          ],
        }))
      }
      return result.skipped ?? []
    },
    [dbChatId],
  )

  const confirmRewind = useCallback(async () => {
    if (!rewindTargetMessageId || dbChatId === undefined) return
    const messageId = rewindTargetMessageId

    try {
      const skipped = await runRewind(messageId, false)
      if (skipped.length > 0) setPendingConflicts({ messageId, files: skipped })
    } catch (err) {
      console.error('[Rewind] Error:', err)
    } finally {
      setRewindDialogOpen(false)
      setRewindTargetMessageId(null)
    }
  }, [dbChatId, rewindTargetMessageId, runRewind])

  const cancelRewind = useCallback(() => {
    setRewindDialogOpen(false)
    setRewindTargetMessageId(null)
  }, [])

  /** Revert the skipped files too, overwriting whatever the other chat left. */
  const confirmConflicts = useCallback(async () => {
    if (!pendingConflicts) return
    try {
      await runRewind(pendingConflicts.messageId, true)
    } catch (err) {
      console.error('[Rewind] Forced rewind error:', err)
    } finally {
      setPendingConflicts(null)
    }
  }, [pendingConflicts, runRewind])

  const dismissConflicts = useCallback(() => setPendingConflicts(null), [])

  const handleUndoRewind = useCallback(async () => {
    if (!rewindedCheckpoint) return

    const activeWorkspace = useProjectStore.getState().getActiveWorkspace()
    const cwd = activeWorkspace?.worktreePath
    if (!cwd) return

    try {
      const result = await api.aiUndoRewind(
        rewindedCheckpoint.backupSnapshotId,
        cwd,
        rewindedCheckpoint.filesChanged,
      )
      if (result.success) {
        setRewindedCheckpoint(null)
      } else {
        console.error('[Rewind] Undo failed:', result.message)
      }
    } catch (err) {
      console.error('[Rewind] Undo error:', err)
    }
  }, [rewindedCheckpoint])

  return {
    rewindDialogOpen,
    setRewindDialogOpen,
    rewindedCheckpoint,
    pendingConflicts,
    handleRewindToCheckpoint,
    confirmRewind,
    cancelRewind,
    confirmConflicts,
    dismissConflicts,
    handleUndoRewind,
  }
}
