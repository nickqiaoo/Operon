import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { executeCanvasWorkflow } from './index.js'
import type { CanvasNode, CanvasWorkflow, NodeResult, NodeResultUpdate } from '../../types/canvas-workflow.js'
import type { CombinedStorage } from './types.js'

interface FakeRun {
  status: 'running' | 'success' | 'error'
  outputs?: Record<string, string>
  error?: string
  nodeResults: Map<string, NodeResult>
}

function createFakeStorage(): { storage: CombinedStorage; runs: Map<number, FakeRun> } {
  const runs = new Map<number, FakeRun>()
  runs.set(1, { status: 'running', nodeResults: new Map() })
  const stub = new Proxy({}, {
    get: (_, prop: string) => {
      switch (prop) {
        case 'updateCanvasNodeResult':
          return (runId: number, nodeId: string, update: NodeResultUpdate) => {
            const run = runs.get(runId)!
            const existing = run.nodeResults.get(nodeId) ?? { nodeId, status: 'pending' }
            run.nodeResults.set(nodeId, { ...existing, ...update, nodeId })
          }
        case 'updateCanvasRunStatus':
          return (runId: number, status: 'success' | 'error', data?: { outputs?: Record<string, string>; error?: string }) => {
            const run = runs.get(runId)!
            run.status = status
            if (data?.outputs) run.outputs = data.outputs
            if (data?.error) run.error = data.error
          }
        case 'getWorkspace':
          return () => undefined
        default:
          return () => { throw new Error(`Unexpected storage call: ${prop}`) }
      }
    },
  }) as CombinedStorage
  return { storage: stub, runs }
}

const pos = { x: 0, y: 0 }
const input = (id: string, prompt: string): CanvasNode => ({ id, type: 'input', name: id, position: pos, data: { prompt } })
const template = (id: string, tpl: string): CanvasNode => ({ id, type: 'template', name: id, position: pos, data: { template: tpl } })
const end = (id: string, outputs: Array<{ key: string; value: string }>): CanvasNode => ({ id, type: 'end', name: id, position: pos, data: { outputs } })
const http = (id: string, data: Partial<import('../../types/canvas-workflow.js').CanvasHttpNodeData>): CanvasNode => ({
  id, type: 'http', name: id, position: pos,
  data: { method: 'GET', url: '', headers: [], bodyType: 'none', body: '', auth: { type: 'none' }, ...data },
})
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })
const workflow = (nodes: CanvasNode[], edges: CanvasWorkflow['edges']): CanvasWorkflow =>
  ({ id: 1, name: 'wf', nodes, edges, createdAt: 0, updatedAt: 0 })

describe('end node', () => {
  it('declares the run outputs instead of the leaves', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [input('a', 'alpha'), template('noise', 'not wanted'), end('done', [{ key: 'summary', value: 'got {{ a }}' }, { key: 'raw', value: '{{ a }}' }])],
      [edge('a', 'noise'), edge('a', 'done')],
    ), 1, storage)
    expect(runs.get(1)!.outputs).toEqual({ summary: 'got alpha', raw: 'alpha' })
  })

  it('falls back to leaf outputs when no End node completed', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow([input('a', 'alpha')], []), 1, storage)
    expect(runs.get(1)!.outputs).toEqual({ a: 'alpha' })
  })
})

describe('http node', () => {
  let server: Server
  let base = ''
  const seen: Array<{ method: string; url: string; auth?: string; contentType?: string; body: string }> = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, contentType: req.headers['content-type'], body })
        if (req.url?.startsWith('/fail')) {
          res.statusCode = 502
          res.end('upstream broke')
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('posts a templated JSON body with bearer auth and parses the JSON reply downstream', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [
        input('msg', 'hi "there"'),
        http('call', {
          method: 'POST',
          url: `${base}/echo?q={{ msg | urlencode }}`,
          bodyType: 'json',
          body: '{"text": {{ msg | tojson }}}',
          auth: { type: 'bearer', token: 'secret-{{ msg | length }}' },
        }),
        template('out', '{{ call.echo.text }} / {{ call.ok }}'),
      ],
      [edge('msg', 'call'), edge('call', 'out')],
    ), 1, storage)
    expect(runs.get(1)!.status).toBe('success')
    expect(runs.get(1)!.outputs).toEqual({ out: 'hi "there" / true' })
    const last = seen.at(-1)!
    expect(last.method).toBe('POST')
    expect(last.auth).toBe('Bearer secret-10')
    expect(last.contentType).toBe('application/json')
  })

  it('fails on non-2xx with the status and a body preview', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow([http('call', { url: `${base}/fail` })], []), 1, storage)
    const error = runs.get(1)!.nodeResults.get('call')?.error ?? ''
    expect(error).toContain('502')
    expect(error).toContain('upstream broke')
  })

  it('refuses to send a body that rendered into broken JSON', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [input('msg', 'a"b'), http('call', { method: 'POST', url: `${base}/echo`, bodyType: 'json', body: '{"text": "{{ msg }}"}' })],
      [edge('msg', 'call')],
    ), 1, storage)
    expect(runs.get(1)!.nodeResults.get('call')?.error).toContain('not valid JSON')
  })
})
