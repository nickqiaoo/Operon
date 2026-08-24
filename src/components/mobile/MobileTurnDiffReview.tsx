import { useCallback, useEffect, useState } from "react"
import { MobileDiffBrowser, type MobileDiffFileBase } from "./MobileDiffBrowser"
import { api } from "@/lib/api"

interface TurnDiffFile extends MobileDiffFileBase {
  diff: string
}

interface MobileTurnDiffReviewProps {
  chatId: number
  rootPath: string
  messageUid: string
}

export function MobileTurnDiffReview({ chatId, rootPath, messageUid }: MobileTurnDiffReviewProps) {
  const [files, setFiles] = useState<TurnDiffFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.aiGetTurnFileDiffs(chatId, rootPath, messageUid)
      setFiles(result.files)
    } catch {
      setFiles([])
      setError("Couldn't load review.")
    } finally {
      setLoading(false)
    }
  }, [chatId, messageUid, rootPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadDiff = useCallback(async (file: TurnDiffFile) => file.diff, [])

  return (
    <MobileDiffBrowser
      title="Review"
      files={files}
      loadDiff={loadDiff}
      viewMode="stacked"
      loading={loading}
      refreshing={loading}
      error={error}
      emptyTitle="No changes this turn"
      emptyDescription="This turn didn't modify any files."
      loadingLabel="Loading review..."
      diffErrorMessage="Couldn't load diff."
      onRefresh={() => void refresh()}
      className="h-[70vh]"
    />
  )
}
