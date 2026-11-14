import { useEffect, useRef, useState } from 'react'
import { AppBridge, PostMessageTransport, type McpUiStyles } from '@modelcontextprotocol/ext-apps/app-bridge'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { SCHEDULE_APP_MIME_TYPE, SCHEDULE_APP_URI } from '@shared/schedule-app'
import { buildHtmlRenderDocument } from '@shared/html-render'
import { useHtmlRenderTheme } from '@/hooks/useHtmlRenderTheme'
import { apiAuthHeaders, getBaseUrl } from '@/lib/api-client'
import { cronjobKeys } from '@/lib/cronjob-queries'
import { queryClient } from '@/lib/query-client'
import { useChatDbId } from './chat-db-id-context'

/** A deliberately narrow first-party host: this app can only read/update its own task. */
export default function ScheduleTaskApp({ taskId }: { taskId: number }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<AppBridge | null>(null)
  const theme = useHtmlRenderTheme()
  const latestTheme = useRef(theme)
  latestTheme.current = theme
  const chatId = useChatDbId()
  const [page, setPage] = useState<string>()
  const [height, setHeight] = useState(490)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let disposed = false
    const client = new Client({ name: 'operon-schedule-ui', version: '1.0.0' })
    let bridge: AppBridge | undefined
    setError(undefined)
    setPage(undefined)

    async function connect() {
      const base = await getBaseUrl()
      if (disposed) return
      const url = new URL(`${base}/schedule-mcp`)
      if (chatId !== undefined) url.searchParams.set('chatId', String(chatId))
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: apiAuthHeaders() } }))
      if (disposed) return
      const [resource, rawTask] = await Promise.all([
        client.readResource({ uri: SCHEDULE_APP_URI }),
        client.callTool({ name: 'schedule_get', arguments: { id: taskId } }, CallToolResultSchema),
      ])
      if (disposed) return
      const task = CallToolResultSchema.parse(rawTask)
      if (task.isError) {
        const text = Array.isArray(task.content) ? task.content.find((item) => item.type === 'text') : undefined
        throw new Error(text?.type === 'text' ? text.text : 'This scheduled task is no longer available.')
      }
      const html = resource.contents.find((item) => item.uri === SCHEDULE_APP_URI && item.mimeType === SCHEDULE_APP_MIME_TYPE)
      if (!html || !('text' in html)) throw new Error('Scheduled task editor is unavailable.')
      const target = frameRef.current?.contentWindow
      if (!target) return
      bridge = new AppBridge(null, { name: 'Operon', version: '1.0.0' }, { serverTools: {} }, {
        hostContext: { theme: latestTheme.current.appearance, displayMode: 'inline', availableDisplayModes: ['inline'] },
      })
      bridgeRef.current = bridge
      bridge.onsizechange = ({ height: nextHeight }) => {
        if (!disposed && nextHeight !== undefined && Number.isFinite(nextHeight)) setHeight(Math.max(80, Math.min(1400, Math.ceil(nextHeight))))
      }
      bridge.oncalltool = async (params) => {
        if (!['schedule_get', 'schedule_update'].includes(params.name) || params.arguments?.id !== taskId) {
          throw new Error('This editor can only read or update its own scheduled task.')
        }
        // No arbitrary provider/workspace changes from the embedded page.
        const allowed = new Set(['id', 'name', 'prompt', 'schedule', 'enabled'])
        if (Object.keys(params.arguments ?? {}).some((key) => !allowed.has(key))) throw new Error('Unsupported task field.')
        const result = CallToolResultSchema.parse(await client.callTool(params, CallToolResultSchema))
        if (params.name === 'schedule_update' && !result.isError) {
          await queryClient.invalidateQueries({ queryKey: cronjobKeys.list() })
        }
        return result
      }
      const activeBridge = bridge
      bridge.oninitialized = () => {
        void (async () => {
          await activeBridge.sendToolInput({ arguments: { id: taskId } })
          await activeBridge.sendToolResult(task)
        })().catch((cause: unknown) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : 'Could not load scheduled task.')
        })
      }
      await bridge.connect(new PostMessageTransport(target, target))
      if (!disposed) setPage(buildHtmlRenderDocument(html.text, latestTheme.current))
    }

    void connect().catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : 'Could not load scheduled task.')
    }).finally(() => {
      if (disposed) void client.close()
    })
    return () => {
      disposed = true
      bridgeRef.current = null
      void bridge?.close()
      void client.close()
    }
  }, [taskId, chatId, attempt])

  useEffect(() => {
    bridgeRef.current?.setHostContext({
      theme: theme.appearance,
      styles: { variables: theme.variables as McpUiStyles },
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
    })
  }, [theme, page])

  return (
    <div className="my-3 w-full max-w-xl">
      {error ? (
        <div className="rounded-xl bg-muted/30 p-4 text-sm text-muted-foreground" role="alert">
          <p>{error}</p>
          <button type="button" className="mt-2 text-xs underline underline-offset-4" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>
      ) : !page ? <p className="py-3 text-xs text-muted-foreground" role="status">Loading scheduled task…</p> : null}
      <iframe
        ref={frameRef}
        title="Scheduled task editor"
        srcDoc={page}
        sandbox="allow-scripts"
        className={page && !error ? 'block w-full border-0' : 'hidden'}
        style={{ height, colorScheme: theme.appearance }}
      />
    </div>
  )
}
