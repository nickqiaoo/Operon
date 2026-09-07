import { describe, it, expect } from 'vitest'
import { executeCanvasWorkflow } from './index.js'
import type { CanvasNode, CanvasWorkflow, CanvasWorkflowRun, NodeResult, NodeResultUpdate } from '../../types/canvas-workflow.js'
import type { CombinedStorage } from './types.js'

interface FakeRun {
  id: number
  parentRunId?: number
  iteration?: number
  status: 'running' | 'success' | 'error'
  outputs?: Record<string, string>
  error?: string
  nodeResults: Map<string, NodeResult>
}

function createFakeStorage(): { storage: CombinedStorage; runs: Map<number, FakeRun> } {
  const runs = new Map<number, FakeRun>()
  runs.set(1, { id: 1, status: 'running', nodeResults: new Map() })
  let nextId = 2
  const stub = new Proxy({}, {
    get: (_, prop: string) => {
      switch (prop) {
        case 'createCanvasRun':
          return (_workflowId: number, options?: { parentRunId?: number; iteration?: number }) => {
            const id = nextId++
            runs.set(id, { id, parentRunId: options?.parentRunId, iteration: options?.iteration, status: 'running', nodeResults: new Map() })
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
        case 'getCanvasRun':
          return (runId: number): CanvasWorkflowRun | null => {
            const run = runs.get(runId)
            if (!run) return null
            return { id: run.id, workflowId: 1, status: run.status, startedAt: 0, outputs: run.outputs, error: run.error, nodeResults: [...run.nodeResults.values()] }
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
const input = (id: string, prompt: string, parentId?: string): CanvasNode => ({ id, type: 'input', name: id, position: pos, data: { prompt }, parentId })
const template = (id: string, tpl: string, parentId?: string): CanvasNode => ({ id, type: 'template', name: id, position: pos, data: { template: tpl }, parentId })
const code = (id: string, body: string, parentId?: string): CanvasNode => ({ id, type: 'code', name: id, position: pos, data: { language: 'javascript', code: body }, parentId })
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })
const workflow = (nodes: CanvasNode[], edges: CanvasWorkflow['edges']): CanvasWorkflow =>
  ({ id: 1, name: 'wf', nodes, edges, createdAt: 0, updatedAt: 0 })

describe('iteration group', () => {
  it('runs the body per item, reads outer variables, and collects outputs in order', async () => {
    const { storage, runs } = createFakeStorage()
    const nodes: CanvasNode[] = [
      input('prefix', 'file'),
      input('files', '["a.ts", "b.ts", "c.ts"]'),
      { id: 'each', type: 'iteration', name: 'each', position: pos, data: { source: '{{ files }}', sourceMode: 'json', concurrency: 2, output: '{{ tag }}' } },
      template('tag', '{{ prefix }}#{{ index }}:{{ item }}', 'each'),
      template('after', '{{ each | length }} tags, last={{ each[2] }}'),
    ]
    await executeCanvasWorkflow(workflow(nodes, [edge('prefix', 'each'), edge('files', 'each'), edge('each', 'after')]), 1, storage)

    const top = runs.get(1)!
    expect(top.status).toBe('success')
    expect(top.outputs).toEqual({ after: '3 tags, last=file#2:c.ts' })
    expect(top.nodeResults.get('each')?.output).toBe('["file#0:a.ts","file#1:b.ts","file#2:c.ts"]')
    // Body node mirrored into the top-level run, plus one child run per item
    expect(top.nodeResults.get('tag')?.status).toBe('success')
    const children = [...runs.values()].filter((r) => r.parentRunId === 1)
    expect(children.map((r) => r.iteration).sort()).toEqual([0, 1, 2])
    expect(children.every((r) => r.status === 'success')).toBe(true)
  })

  it('splits lines and fails with the item index when a body node fails', async () => {
    const { storage, runs } = createFakeStorage()
    const nodes: CanvasNode[] = [
      input('list', 'one\ntwo\n\nthree'),
      { id: 'each', type: 'iteration', name: 'each', position: pos, data: { source: '{{ list }}', sourceMode: 'lines', concurrency: 1, output: '{{ check }}' } },
      code('check', 'if (inputs.item === "two") throw new Error("boom"); return inputs.item.toUpperCase()', 'each'),
    ]
    await executeCanvasWorkflow(workflow(nodes, [edge('list', 'each')]), 1, storage)
    const top = runs.get(1)!
    expect(top.status).toBe('error')
    expect(top.nodeResults.get('each')?.error).toContain('item 1')
    expect(top.nodeResults.get('each')?.error).toContain('boom')
  })
})

describe('loop group', () => {
  it('carries variables across rounds and exits on the condition', async () => {
    const { storage, runs } = createFakeStorage()
    const nodes: CanvasNode[] = [
      { id: 'grow', type: 'loop', name: 'grow', position: pos, data: {
        until: 'loop.total >= 10',
        maxIterations: 20,
        variables: [{ name: 'total', initial: '1', next: '{{ doubled }}' }],
        output: '{"final": {{ loop.total }}}',
      } },
      code('doubled', 'return Number(inputs.loop.total) * 2', 'grow'),
    ]
    await executeCanvasWorkflow(workflow(nodes, []), 1, storage)
    const top = runs.get(1)!
    expect(top.status).toBe('success')
    expect(JSON.parse(top.outputs!.grow)).toEqual({ final: 16, iterations: 4, exhausted: false })
  })

  it('stops at the cap and reports exhausted', async () => {
    const { storage, runs } = createFakeStorage()
    const nodes: CanvasNode[] = [
      { id: 'spin', type: 'loop', name: 'spin', position: pos, data: { until: 'false', maxIterations: 3, variables: [], output: '{{ loop.index }}' } },
      template('noop', 'x', 'spin'),
    ]
    await executeCanvasWorkflow(workflow(nodes, []), 1, storage)
    expect(JSON.parse(runs.get(1)!.outputs!.spin)).toEqual({ result: '2', iterations: 3, exhausted: true })
  })
})
