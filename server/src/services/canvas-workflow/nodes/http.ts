import type { CanvasHttpNodeData, CanvasNode } from '../../../types/canvas-workflow.js'
import { DEFAULT_NODE_TIMEOUT_MS } from '../limits.js'
import type { NodeExecutorDefinition } from '../types.js'

const BODY_PREVIEW_CHARS = 2048

function buildBody(
  bodyType: CanvasHttpNodeData['bodyType'],
  rendered: string,
  headers: Headers
): string | undefined {
  switch (bodyType) {
    case 'none':
      return undefined
    case 'json': {
      try {
        JSON.parse(rendered)
      } catch {
        throw new Error('http failed: rendered body is not valid JSON')
      }
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
      return rendered
    }
    case 'form': {
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded')
      return rendered
    }
    case 'text':
    default:
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8')
      return rendered
  }
}

/**
 * Deterministic HTTP call: the workflow's door to webhooks and APIs in both
 * directions. Every text field is a template, so secrets come in as
 * `{{ env.TOKEN }}` and never sit in the saved workflow.
 */
export const httpNode: NodeExecutorDefinition = {
  timeoutMs: (node: CanvasNode) =>
    (node.data as CanvasHttpNodeData).timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,

  execute: async (ctx) => {
    const data = ctx.node.data as CanvasHttpNodeData
    const url = ctx.render(data.url ?? '').trim()
    if (url.length === 0) throw new Error('http failed: url is empty')

    const headers = new Headers()
    for (const header of data.headers ?? []) {
      const key = header.key.trim()
      if (!key) continue
      headers.set(key, ctx.render(header.value ?? ''))
    }

    const auth = data.auth ?? { type: 'none' }
    if (auth.type === 'bearer') {
      headers.set('authorization', `Bearer ${ctx.render(auth.token ?? '')}`)
    } else if (auth.type === 'basic') {
      const credentials = `${ctx.render(auth.username ?? '')}:${ctx.render(auth.password ?? '')}`
      headers.set('authorization', `Basic ${Buffer.from(credentials).toString('base64')}`)
    }

    const method = data.method ?? 'GET'
    const bodyType = method === 'GET' ? 'none' : (data.bodyType ?? 'none')
    const body = buildBody(bodyType, ctx.render(data.body ?? ''), headers)

    let response: Response
    try {
      response = await fetch(url, { method, headers, body, signal: ctx.signal })
    } catch (error) {
      throw new Error(`http failed: ${(error as Error).message}`)
    }

    const text = await response.text()
    if (!response.ok && (data.failOnNon2xx ?? true)) {
      const preview = text.trim().slice(0, BODY_PREVIEW_CHARS)
      throw new Error(`http failed: ${response.status} ${response.statusText}${preview ? `\n${preview}` : ''}`)
    }
    return text
  },
}
