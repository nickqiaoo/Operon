import { createHmac } from 'crypto'
import { createTwoFilesPatch } from 'diff'
import type { DiffWorkerConfig } from './im/types.js'

const DIFF_TTL_SECONDS = 60 * 60

interface DiffUploadResult {
  viewUrl: string
  id: string
}

interface DiffUploadResponse {
  id: string
  expiresAt: number
}

interface DiffStats {
  additions: number
  deletions: number
}

export function createDiffPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  const fileName = filePath.split('/').pop() || filePath
  return createTwoFilesPatch(fileName, fileName, oldContent, newContent)
}

export function countDiffStats(patch: string): DiffStats {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

export async function uploadDiff(
  patch: string,
  fileName: string,
  stats: DiffStats,
  chatId: string,
  config: DiffWorkerConfig,
): Promise<DiffUploadResult> {
  const url = `${config.workerUrl}/api/diff`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.workerApiKey}`,
    },
    body: JSON.stringify({
      patch,
      fileName,
      additions: stats.additions,
      deletions: stats.deletions,
      chatId: String(chatId),
    }),
  })

  if (!response.ok) {
    throw new Error(`Diff upload failed: ${response.status} ${response.statusText} (url=${url})`)
  }

  const data = await response.json() as DiffUploadResponse
  const expiresAt = Number.isInteger(data.expiresAt)
    ? data.expiresAt
    : Math.floor(Date.now() / 1000) + DIFF_TTL_SECONDS
  const sig = signDiffViewId(data.id, expiresAt, config.workerApiKey)

  return {
    id: data.id,
    viewUrl: `${config.workerUrl}/diff?id=${encodeURIComponent(data.id)}&exp=${expiresAt}&sig=${encodeURIComponent(sig)}`,
  }
}

export async function processAndUploadDiff(params: {
  filePath: string
  oldContent: string
  newContent: string
  chatId: string
  config: DiffWorkerConfig
}): Promise<DiffUploadResult | null> {
  const { filePath, oldContent, newContent, chatId, config } = params

  try {
    const patch = createDiffPatch(filePath, oldContent, newContent)

    const stats = countDiffStats(patch)
    if (stats.additions === 0 && stats.deletions === 0) return null

    const fileName = filePath.split('/').pop() ?? filePath
    return await uploadDiff(patch, fileName, stats, chatId, config)
  } catch (err) {
    console.error('[DiffService] Failed to process diff:', err)
    return null
  }
}

function signDiffViewId(id: string, exp: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${id}.${exp}`)
    .digest('base64url')
}
