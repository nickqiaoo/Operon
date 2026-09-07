import { describe, it, expect } from 'vitest'
import { executeCanvasWorkflow } from './index.js'
import type {
  CanvasWorkflow,
  NodeResult,
  NodeResultUpdate,
} from '../../types/canvas-workflow.js'
import type { CombinedStorage } from './types.js'

interface FakeRun {
  status: 'running' | 'success' | 'error'
  outputs?: Record<string, string>
  error?: string
  nodeResults: Map<string, NodeResult>
}

function createFakeStorage(): {
  storage: CombinedStorage
  runs: Map<number, FakeRun>
} {
  const runs = new Map<number, FakeRun>()
  runs.set(1, { status: 'running', nodeResults: new Map() })

  const stub = new Proxy({}, {
    get: (_, prop: string) => {
      switch (prop) {
        case 'updateCanvasNodeResult':
          return (runId: number, nodeId: string, update: NodeResultUpdate) => {
            const run = runs.get(runId)
            if (!run) return
            const existing = run.nodeResults.get(nodeId) ?? { nodeId, status: 'pending' }
            run.nodeResults.set(nodeId, { ...existing, ...update, nodeId })
          }
        case 'updateCanvasRunStatus':
          return (
            runId: number,
            status: 'success' | 'error',
            data?: { outputs?: Record<string, string>; error?: string },
          ) => {
            const run = runs.get(runId)
            if (!run) return
            run.status = status
            if (data?.outputs) run.outputs = data.outputs
            if (data?.error) run.error = data.error
          }
        case 'getWorkspace':
          return () => undefined
        default:
          return () => {
            throw new Error(`Unexpected storage call: ${prop}`)
          }
      }
    },
  }) as CombinedStorage

  return { storage: stub, runs }
}

const makeInputNode = (id: string, prompt: string): CanvasWorkflow['nodes'][number] => ({
  id,
  type: 'input',
  name: id,
  position: { x: 0, y: 0 },
  data: { prompt },
})

describe('executeCanvasWorkflow (input-only DAG)', () => {
  it('executes a single input node and surfaces its prompt as leaf output', async () => {
    const { storage, runs } = createFakeStorage()
    const workflow: CanvasWorkflow = {
      id: 1,
      name: 'wf',
      nodes: [makeInputNode('a', 'hello world')],
      edges: [],
      createdAt: 0,
      updatedAt: 0,
    }

    await executeCanvasWorkflow(workflow, 1, storage)

    const run = runs.get(1)!
    expect(run.status).toBe('success')
    expect(run.outputs).toEqual({ a: 'hello world' })
    expect(run.nodeResults.get('a')?.status).toBe('success')
    expect(run.nodeResults.get('a')?.output).toBe('hello world')
  })

  it('executes a diamond DAG (1→2, 1→3, 3→4) honoring dependencies', async () => {
    const { storage, runs } = createFakeStorage()
    const workflow: CanvasWorkflow = {
      id: 1,
      name: 'diamond',
      nodes: [
        makeInputNode('n1', 'root'),
        makeInputNode('n2', 'left'),
        makeInputNode('n3', 'middle'),
        makeInputNode('n4', 'leaf'),
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n1', target: 'n3' },
        { id: 'e3', source: 'n3', target: 'n4' },
      ],
      createdAt: 0,
      updatedAt: 0,
    }

    await executeCanvasWorkflow(workflow, 1, storage)

    const run = runs.get(1)!
    expect(run.status).toBe('success')
    // n2 and n4 are the leaves (no outgoing edges)
    expect(Object.keys(run.outputs!).sort()).toEqual(['n2', 'n4'])
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      expect(run.nodeResults.get(id)?.status).toBe('success')
    }
  })

  it('marks the whole run success even if one branch errors (leaf finishes)', async () => {
    // An input node with non-string prompt will throw inside executeInputNode.
    const { storage, runs } = createFakeStorage()
    const workflow: CanvasWorkflow = {
      id: 1,
      name: 'two-indep',
      nodes: [
        makeInputNode('a', 'alpha'),
        makeInputNode('b', 'beta'),
      ],
      edges: [],
      createdAt: 0,
      updatedAt: 0,
    }

    await executeCanvasWorkflow(workflow, 1, storage)

    const run = runs.get(1)!
    expect(run.status).toBe('success')
    expect(run.outputs).toEqual({ a: 'alpha', b: 'beta' })
  })
})

// An AI node without a workspace fails deterministically before touching any
// provider, which makes it a handy failure injector for engine tests.
const makeFailingNode = (id: string): CanvasWorkflow['nodes'][number] => ({
  id,
  type: 'ai',
  name: id,
  position: { x: 0, y: 0 },
  data: { providerId: 'none', userPrompt: 'x' },
})

const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })

describe('executeCanvasWorkflow (failures and skips)', () => {
  it('skips everything downstream of a failed node and marks the run as error', async () => {
    const { storage, runs } = createFakeStorage()
    const workflow: CanvasWorkflow = {
      id: 1,
      name: 'fail-chain',
      nodes: [makeInputNode('a', 'alpha'), makeFailingNode('bad'), makeInputNode('c', 'gamma'), makeInputNode('d', 'delta')],
      edges: [edge('a', 'bad'), edge('bad', 'c'), edge('c', 'd')],
      createdAt: 0,
      updatedAt: 0,
    }

    await executeCanvasWorkflow(workflow, 1, storage)

    const run = runs.get(1)!
    expect(run.status).toBe('error')
    expect(run.error).toContain('Node "bad" failed')
    expect(run.nodeResults.get('a')?.status).toBe('success')
    expect(run.nodeResults.get('bad')?.status).toBe('error')
    expect(run.nodeResults.get('c')?.status).toBe('skipped')
    expect(run.nodeResults.get('d')?.status).toBe('skipped')
    expect(run.outputs).toEqual({})
  })

  it('still runs a fan-in node when at least one predecessor completed', async () => {
    const { storage, runs } = createFakeStorage()
    const workflow: CanvasWorkflow = {
      id: 1,
      name: 'fan-in',
      nodes: [makeInputNode('a', 'alpha'), makeFailingNode('bad'), makeInputNode('join', 'joined')],
      edges: [edge('a', 'join'), edge('bad', 'join')],
      createdAt: 0,
      updatedAt: 0,
    }

    await executeCanvasWorkflow(workflow, 1, storage)

    const run = runs.get(1)!
    expect(run.status).toBe('error')
    expect(run.nodeResults.get('join')?.status).toBe('success')
    expect(run.outputs).toEqual({ join: 'joined' })
  })

  it('keeps independent branches running while one fails', async () => {
    const { storage, runs } = createFakeStorage()
    const workflow: CanvasWorkflow = {
      id: 1,
      name: 'independent',
      nodes: [makeFailingNode('bad'), makeInputNode('a', 'alpha'), makeInputNode('b', 'beta')],
      edges: [edge('a', 'b')],
      createdAt: 0,
      updatedAt: 0,
    }

    await executeCanvasWorkflow(workflow, 1, storage)

    const run = runs.get(1)!
    expect(run.status).toBe('error')
    expect(run.nodeResults.get('b')?.status).toBe('success')
    expect(run.outputs).toEqual({ b: 'beta' })
  })
})
