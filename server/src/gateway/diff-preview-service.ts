import type { DiffPreview, DiffWorkerConfig, PendingDiff } from './im/types.js'
import { processAndUploadDiff } from './diff-service.js'

export class DiffPreviewService {
  constructor(private readonly getConfig: () => DiffWorkerConfig | null) {}

  isEnabled(): boolean {
    const config = this.getConfig()
    return !!(config?.workerUrl && config?.workerApiKey)
  }

  async upload(chatId: string, diff: PendingDiff): Promise<DiffPreview | null> {
    const config = this.getConfig()
    if (!config?.workerUrl || !config?.workerApiKey) return null
    const result = await processAndUploadDiff({
      filePath: diff.filePath,
      oldContent: diff.oldContent,
      newContent: diff.newContent,
      chatId,
      config,
    })
    if (!result) return null

    const fileName = diff.filePath.split('/').pop() ?? diff.filePath
    return { viewUrl: result.viewUrl, fileName }
  }
}
