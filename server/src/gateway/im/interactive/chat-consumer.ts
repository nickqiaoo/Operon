import type { TextStreamPart, ToolSet } from 'ai'
import type { DiffPreviewService } from '../../diff-preview-service.js'
import type { ChannelRef, IMProvider, PendingDiff } from '../types.js'
import type { PermissionHandler } from '../permission-handler.js'
import { forwardApprovalEvent } from '../approval-forwarder.js'

const DRAFT_THROTTLE_MS = 400
const DRAFT_MIN_DELTA = 80
const MAX_DIFF_SIZE = 200_000

type FullStreamEvent = TextStreamPart<ToolSet>

const EDIT_TOOL_NAMES = new Set(['edit', 'replace'])
const WRITE_TOOL_NAMES = new Set(['write', 'write_file'])

export interface StreamConsumerOptions {
  provider: IMProvider
  ref: ChannelRef
  channelKey: string
  fullStream: AsyncIterable<FullStreamEvent>
  internalChatId: number
  signal: AbortSignal
  permissionHandler: PermissionHandler
  diffPreviewService: DiffPreviewService
}

export async function consumeFullStream(options: StreamConsumerOptions): Promise<void> {
  const {
    provider, ref, channelKey, fullStream, internalChatId,
    signal, permissionHandler, diffPreviewService,
  } = options

  const writer = provider.createStreamWriter(ref)
  let textSoFar = ''
  let lastUpdateAt = 0
  let lastDraftLength = 0
  let draftInFlight = false
  let phase: 'streaming' | 'paused' | 'finalized' = 'streaming'

  let currentToolName = ''
  let currentToolText = ''
  let toolNotificationId: string | undefined

  let reasoningNotificationId: string | undefined
  let reasoningStartTime = 0

  let pendingDiffInput: PendingDiff | undefined

  const flushDraft = () => {
    if (draftInFlight) return
    draftInFlight = true
    const snapshot = textSoFar
    writer.update(snapshot)
      .catch(() => {})
      .finally(() => { draftInFlight = false })
    lastUpdateAt = Date.now()
    lastDraftLength = snapshot.length
  }

  try {
    for await (const event of fullStream) {
      if (signal.aborted) break

      switch (event.type) {
        case 'text-delta': {
          textSoFar += event.text
          phase = 'streaming'
          const now = Date.now()
          const textDelta = textSoFar.length - lastDraftLength
          if (textDelta >= DRAFT_MIN_DELTA || now - lastUpdateAt >= DRAFT_THROTTLE_MS) {
            flushDraft()
          }
          break
        }

        case 'reasoning-start': {
          if (textSoFar.trim()) {
            await writer.finish(textSoFar)
            textSoFar = ''
            lastDraftLength = 0
          }
          phase = 'paused'
          reasoningStartTime = Date.now()
          reasoningNotificationId = await provider.sendToolNotification(ref, '🧠 Thinking...')
          break
        }

        case 'reasoning-delta': break

        case 'reasoning-end': {
          if (reasoningNotificationId) {
            const elapsed = Math.ceil((Date.now() - reasoningStartTime) / 1000)
            const label = elapsed > 0 ? `Thought for ${elapsed}s` : 'Thought for a moment'
            await provider.updateToolNotification(ref, reasoningNotificationId, `🧠 ${label}`)
          }
          reasoningNotificationId = undefined
          reasoningStartTime = 0
          phase = 'streaming'
          break
        }

        case 'tool-input-start': {
          if (textSoFar.trim()) {
            await writer.finish(textSoFar)
            textSoFar = ''
            lastDraftLength = 0
          }
          phase = 'paused'
          currentToolName = String(event.toolName ?? '')
          break
        }

        case 'tool-call': {
          currentToolName = event.toolName
          currentToolText = formatToolCall(currentToolName, event.input)
          toolNotificationId = await provider.sendToolNotification(ref, currentToolText)

          if (diffPreviewService.isEnabled()) {
            pendingDiffInput = capturePendingDiff(currentToolName, event.input)
            if (pendingDiffInput) {
              diffPreviewService.upload(channelKey, pendingDiffInput)
                .then((preview) => {
                  if (preview) return provider.sendDiffPreview(ref, preview)
                })
                .catch((err) => {
                  console.error('[Interactive:Diff] preview failed:',
                    err instanceof Error ? err.message : err)
                })
            }
          }
          break
        }

        case 'tool-result': {
          if (toolNotificationId && currentToolName) {
            await provider.updateToolNotification(ref, toolNotificationId, `✅ ${currentToolText}`)
          }
          pendingDiffInput = undefined
          toolNotificationId = undefined
          currentToolName = ''
          currentToolText = ''
          phase = 'streaming'
          break
        }

        case 'tool-error': {
          if (toolNotificationId && currentToolName) {
            await provider.updateToolNotification(ref, toolNotificationId, `❌ ${currentToolText}`)
          }
          pendingDiffInput = undefined
          toolNotificationId = undefined
          currentToolName = ''
          currentToolText = ''
          phase = 'streaming'
          break
        }

        case 'tool-approval-request': {
          await forwardApprovalEvent({
            event,
            handler: permissionHandler,
            provider,
            ref,
            channelKey,
            internalChatId,
          })
          break
        }

        case 'tool-output-denied': {
          pendingDiffInput = undefined
          toolNotificationId = undefined
          currentToolName = ''
          currentToolText = ''
          phase = 'streaming'
          break
        }

        case 'finish': {
          if (textSoFar.trim()) {
            await writer.finish(textSoFar)
            textSoFar = ''
          }
          phase = 'finalized'
          break
        }

        case 'error': {
          const errorText = String(event.error ?? 'Unknown error')
          console.error(`[Interactive:Stream] error: ${errorText}`)
          if (textSoFar.trim()) {
            await writer.finish(textSoFar)
            textSoFar = ''
          }
          await provider.send(ref, `❌ **Error**: ${errorText}`)
          phase = 'finalized'
          break
        }

        default: break
      }
    }
  } catch (err) {
    if (signal.aborted) return
    console.error('[Interactive:Stream] consumption error:', err)
    if (textSoFar.trim()) {
      await writer.finish(textSoFar).catch(() => '')
      textSoFar = ''
    }
    const errorMsg = err instanceof Error ? err.message : 'Stream interrupted'
    await provider.send(ref, `❌ ${errorMsg}`).catch(() => {})
  }

  if (textSoFar.trim() && phase !== 'finalized') {
    await writer.finish(textSoFar).catch(() => '')
  }
}

function capturePendingDiff(toolName: string, input: unknown): PendingDiff | undefined {
  const lower = toolName.toLowerCase().replace(/[`\s]/g, '')
  const record = parseToolInput(input)
  if (!record) return undefined

  if (EDIT_TOOL_NAMES.has(lower)) {
    const filePath = String(record.file_path ?? record.filePath ?? '')
    const oldContent = String(record.old_string ?? record.oldString ?? '')
    const newContent = String(record.new_string ?? record.newString ?? '')
    if (!filePath || !oldContent || !newContent) return undefined
    if (oldContent === newContent) return undefined
    if (oldContent.length + newContent.length > MAX_DIFF_SIZE) return undefined
    return { filePath, oldContent, newContent }
  }
  if (WRITE_TOOL_NAMES.has(lower)) {
    const filePath = String(record.file_path ?? record.filePath ?? '')
    const newContent = String(record.content ?? '')
    if (!filePath || !newContent) return undefined
    if (newContent.length > MAX_DIFF_SIZE) return undefined
    return { filePath, oldContent: '', newContent }
  }
  return undefined
}

function parseToolInput(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === 'object' && input !== null) return input as Record<string, unknown>
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch { /* not JSON */ }
  }
  return undefined
}

const TOOL_ICONS: Record<string, string> = {
  read: '📖 Read', cat: '📖 Read', read_file: '📖 Read',
  write: '✍️ Write', write_file: '✍️ Write',
  edit: '✏️ Edit', replace: '✏️ Edit',
  multiedit: '✏️ MultiEdit', patch: '✏️ Patch',
  bash: '⚡ Bash', exec: '⚡ Bash', run_shell_command: '⚡ Bash', shell: '⚡ Bash',
  glob: '🔍 Glob', find: '🔍 Find', list_files: '🔍 List',
  grep: '🔎 Grep', search: '🔎 Search', ripgrep: '🔎 Grep',
  ls: '📁 LS',
  agent: '🤖 Agent', external_agent_run: '🤖 Agent',
  websearch: '🌐 WebSearch', web_search: '🌐 WebSearch',
  webfetch: '🌐 WebFetch', web_fetch: '🌐 WebFetch', fetch: '🌐 Fetch',
  notebookedit: '📓 NotebookEdit',
}

const TOOL_DESCRIPTION_FIELDS: Record<string, string[]> = {
  bash: ['command'], exec: ['command'], run_shell_command: ['command'], shell: ['command'],
  read: ['file_path', 'path', 'filePath'], cat: ['file_path', 'path'], read_file: ['file_path', 'path'],
  write: ['file_path', 'path'], edit: ['file_path', 'path'], replace: ['file_path', 'path'],
  write_file: ['file_path', 'path'], patch: ['file_path', 'path'],
  notebookedit: ['notebook_path'],
  grep: ['pattern'], search: ['pattern', 'query'], ripgrep: ['pattern'],
  glob: ['pattern'], find: ['pattern', 'path'], list_files: ['pattern', 'path'],
  websearch: ['query'], web_search: ['query'], google_search: ['query'],
  webfetch: ['url'], web_fetch: ['url'], fetch: ['url'],
  agent: ['description', 'subagent_type'],
  external_agent_run: ['description', 'agent_type'],
  mcp__external_agent__external_agent_run: ['description', 'agent_type'],
}

const FALLBACK_FIELDS = [
  'command', 'file_path', 'path', 'pattern', 'query',
  'url', 'description', 'notebook_path', 'skill',
]

function formatToolName(name: string): string {
  const lower = name.toLowerCase().replace(/[`\s]/g, '')
  return TOOL_ICONS[lower] || `🔧 ${name}`
}

function formatToolCall(toolName: string, args: unknown): string {
  const displayName = formatToolName(toolName)
  const input = getRecord(args)
  if (!input) return displayName

  const lower = toolName.toLowerCase().replace(/[`\s]/g, '')
  const fields = TOOL_DESCRIPTION_FIELDS[lower] ?? FALLBACK_FIELDS

  for (const field of fields) {
    const value = input[field]
    if (typeof value === 'string' && value.length > 0) {
      return `${displayName} ${formatDetail(field, value)}`
    }
  }

  if (TOOL_DESCRIPTION_FIELDS[lower]) {
    for (const field of FALLBACK_FIELDS) {
      const value = input[field]
      if (typeof value === 'string' && value.length > 0) {
        return `${displayName} ${formatDetail(field, value)}`
      }
    }
  }

  return displayName
}

function formatDetail(field: string, value: string): string {
  if (field === 'command') return `\`${value.slice(0, 300)}\``
  if (field === 'file_path' || field === 'path' || field === 'notebook_path') {
    return String(value.split('/').pop() || value)
  }
  if (field === 'pattern' || field === 'query') return `\`${value.slice(0, 200)}\``
  if (field === 'url') return value.slice(0, 200)
  return value.slice(0, 200)
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch { /* not JSON */ }
  }
  return undefined
}
