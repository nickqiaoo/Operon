import { describe, it, expect } from 'vitest'
import { executeCanvasWorkflow } from './index.js'
import { decideApproval, getPendingApproval } from './approvals.js'
import type { CanvasNode, CanvasWorkflow, NodeResult, NodeResultUpdate } from '../../types/canvas-workflow.js'
import type { NotifyInput } from '../../types/notification.js'
import type { CombinedStorage } from './types.js'

interface FakeRun {
  id: number
  parentRunId?: number
  status: 'running' | 'success' | 'error'
  outputs?: Record<string, string>
  error?: string
  nodeResults: Map<string, NodeResult>
}

function createFakeStorage(workflows: CanvasWorkflow[]): {
  storage: CombinedStorage
  runs: Map<number, FakeRun>
  notifications: NotifyInput[]
  readSources: string[]
} {
  const runs = new Map<number, FakeRun>()
  runs.set(1, { id: 1, status: 'running', nodeResults: new Map() })
  const notifications: NotifyInput[] = []
  const readSources: string[] = []
  let nextId = 2
  const stub = new Proxy({}, {
    get: (_, prop: string) => {
      switch (prop) {
        case 'getCanvasWorkflow':
          return (id: number) => workflows.find((w) => w.id === id) ?? null
        case 'createCanvasRun':
          return (_workflowId: number, options?: { parentRunId?: number }) => {
            const id = nextId++
            runs.set(id, { id, parentRunId: options?.parentRunId, status: 'running', nodeResults: new Map() })
            return id
          }
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
        case 'notificationUpsert':
          return (input: NotifyInput) => { notifications.push(input); return { ...input, id: notifications.length } }
        case 'notificationUnreadCounts':
          return () => ({ action: 0, info: 0, total: 0 })
        case 'notificationMarkReadBySource':
          return (sourceKey: string) => { readSources.push(sourceKey); return [] }
        case 'getWorkspace':
          return () => undefined
        default:
          return () => { throw new Error(`Unexpected storage call: ${prop}`) }
      }
    },
  }) as CombinedStorage
  return { storage: stub, runs, notifications, readSources }
}

const pos = { x: 0, y: 0 }
const input = (id: string, prompt: string): CanvasNode => ({ id, type: 'input', name: id, position: pos, data: { prompt } })
const template = (id: string, tpl: string): CanvasNode => ({ id, type: 'template', name: id, position: pos, data: { template: tpl } })
const end = (id: string, outputs: Array<{ key: string; value: string }>): CanvasNode => ({ id, type: 'end', name: id, position: pos, data: { outputs } })
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })
const wf = (id: number, name: string, nodes: CanvasNode[], edges: CanvasWorkflow['edges']): CanvasWorkflow =>
  ({ id, name, nodes, edges, createdAt: 0, updatedAt: 0 })

describe('sub-workflow node', () => {
  // The child never declares `who`; the caller hands it in and templates just use it.
  const child = wf(2, 'child', [template('greet', 'hello {{ who }}'), end('done', [{ key: 'greeting', value: '{{ greet }}' }])], [edge('greet', 'done')])

  it('runs the child with caller-supplied variables and returns its End outputs', async () => {
    const parent = wf(1, 'parent', [
      input('name', 'operon'),
      { id: 'call', type: 'subworkflow', name: 'call', position: pos, data: { workflowId: 2, inputs: [{ key: 'who', value: '{{ name }}!' }] } },
      template('out', '{{ call.greeting | upper }}'),
    ], [edge('name', 'call'), edge('call', 'out')])
    const { storage, runs } = createFakeStorage([parent, child])
    await executeCanvasWorkflow(parent, 1, storage)
    const top = runs.get(1)!
    expect(top.status).toBe('success')
    expect(top.outputs).toEqual({ out: 'HELLO OPERON!' })
    const childRun = [...runs.values()].find((r) => r.parentRunId === 1)!
    expect(childRun.status).toBe('success')
    expect(childRun.outputs).toEqual({ greeting: 'hello operon!' })
  })

  it('passes JSON variables as data and rejects a cycle', async () => {
    const parent = wf(1, 'parent', [
      { id: 'call', type: 'subworkflow', name: 'call', position: pos, data: { workflowId: 2, inputs: [{ key: 'who', value: '{"name": "obj"}' }] } },
    ], [])
    const { storage, runs } = createFakeStorage([parent, child])
    await executeCanvasWorkflow(parent, 1, storage)
    expect(JSON.parse(runs.get(1)!.outputs!.call)).toEqual({ greeting: 'hello {"name":"obj"}' })

    const selfCall = wf(3, 'self', [{ id: 'me', type: 'subworkflow', name: 'me', position: pos, data: { workflowId: 3, inputs: [] } }], [])
    const cyc = createFakeStorage([selfCall])
    await executeCanvasWorkflow(selfCall, 1, cyc.storage)
    expect(cyc.runs.get(1)!.nodeResults.get('me')?.error).toContain('cycle')
  })
})

describe('approval node', () => {
  const gated = wf(1, 'gated', [
    input('plan', 'deploy v2'),
    { id: 'gate', type: 'approval', name: 'gate', position: pos, data: { message: 'Deploy {{ plan }}?' } },
    template('after', 'went ahead with {{ plan }}'),
  ], [edge('plan', 'gate'), edge('gate', 'after')])

  it('waits in the inbox, then continues on approve', async () => {
    const { storage, runs, notifications, readSources } = createFakeStorage([gated])
    const running = executeCanvasWorkflow(gated, 1, storage)
    await new Promise((r) => setTimeout(r, 20))
    expect(runs.get(1)!.nodeResults.get('gate')?.status).toBe('waiting')
    expect(notifications[0]?.kind).toBe('workflow_approval')
    expect(notifications[0]?.body).toBe('Deploy deploy v2?')
    expect(getPendingApproval(1, 'gate')).toBeDefined()

    expect(decideApproval(1, 'gate', { approved: true, comment: 'go' })).toBe(true)
    await running
    expect(runs.get(1)!.status).toBe('success')
    expect(runs.get(1)!.outputs).toEqual({ after: 'went ahead with deploy v2' })
    expect(readSources).toEqual(['canvas-approval:1:gate'])
    expect(decideApproval(1, 'gate', { approved: true })).toBe(false)
  })

  it('fails the node and skips downstream on reject', async () => {
    const { storage, runs } = createFakeStorage([gated])
    const running = executeCanvasWorkflow(gated, 1, storage)
    await new Promise((r) => setTimeout(r, 20))
    decideApproval(1, 'gate', { approved: false, comment: 'not today' })
    await running
    expect(runs.get(1)!.status).toBe('error')
    expect(runs.get(1)!.nodeResults.get('gate')?.error).toContain('not today')
    expect(runs.get(1)!.nodeResults.get('after')?.status).toBe('skipped')
  })

  it('times out when configured', async () => {
    const quick = wf(1, 'quick', [{ id: 'gate', type: 'approval', name: 'gate', position: pos, data: { message: 'hi', timeoutMs: 50 } }], [])
    const { storage, runs } = createFakeStorage([quick])
    await executeCanvasWorkflow(quick, 1, storage)
    expect(runs.get(1)!.nodeResults.get('gate')?.error).toContain('timed out')
    expect(getPendingApproval(1, 'gate')).toBeUndefined()
  })
})
