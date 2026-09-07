import { describe, it, expect } from 'vitest'
import { executeCanvasWorkflow } from './index.js'
import type {
  CanvasNode,
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
const shell = (id: string, command: string, extra: Partial<{ failOnNonZero: boolean; timeoutMs: number }> = {}): CanvasNode =>
  ({ id, type: 'shell', name: id, position: pos, data: { command, ...extra } })
const code = (id: string, body: string): CanvasNode => ({ id, type: 'code', name: id, position: pos, data: { language: 'javascript', code: body } })
const ifNode = (id: string, cases: Array<{ id: string; expression: string }>): CanvasNode => ({ id, type: 'if', name: id, position: pos, data: { cases } })
const edge = (source: string, target: string, sourceHandle?: string) =>
  ({ id: `${source}-${target}-${sourceHandle ?? ''}`, source, target, sourceHandle })

function workflow(nodes: CanvasNode[], edges: CanvasWorkflow['edges']): CanvasWorkflow {
  return { id: 1, name: 'wf', nodes, edges, createdAt: 0, updatedAt: 0 }
}

describe('template node', () => {
  it('sees every completed node, not only direct predecessors', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [input('first', 'alpha'), input('second', 'beta'), template('out', '{{ first }}+{{ second }}')],
      [edge('first', 'second'), edge('second', 'out')],
    ), 1, storage)
    expect(runs.get(1)!.outputs).toEqual({ out: 'alpha+beta' })
  })

  it('exposes JSON outputs as objects', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [input('review', '{"passed": false, "issues": ["a", "b"]}'), template('out', '{{ review.issues | length }} issues, passed={{ review.passed }}')],
      [edge('review', 'out')],
    ), 1, storage)
    expect(runs.get(1)!.outputs).toEqual({ out: '2 issues, passed=false' })
  })
})

describe('shell node', () => {
  it('captures stdout and renders the command as a template', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [input('word', 'hello'), shell('echo', 'printf "%s" "{{ word }}"')],
      [edge('word', 'echo')],
    ), 1, storage)
    expect(runs.get(1)!.status).toBe('success')
    expect(runs.get(1)!.outputs).toEqual({ echo: 'hello' })
  })

  it('fails on a non-zero exit and reports stderr', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow([shell('bad', 'echo boom >&2; exit 3')], []), 1, storage)
    const run = runs.get(1)!
    expect(run.status).toBe('error')
    expect(run.nodeResults.get('bad')?.error).toContain('exit code 3')
    expect(run.nodeResults.get('bad')?.error).toContain('boom')
  })

  it('tolerates a non-zero exit when told to', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow([shell('lenient', 'echo out; exit 1', { failOnNonZero: false })], []), 1, storage)
    expect(runs.get(1)!.status).toBe('success')
    expect(runs.get(1)!.outputs?.lenient).toBe('out\n')
  })

  it('times out a hung command', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow([shell('slow', 'sleep 5', { timeoutMs: 200 })], []), 1, storage)
    expect(runs.get(1)!.nodeResults.get('slow')?.error).toContain('timed out')
  })
})

describe('code node', () => {
  it('returns objects as JSON so downstream templates get data', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [input('list', '["x", "y", "z"]'), code('pick', 'return { count: inputs.list.length, last: inputs.list[inputs.list.length - 1] }'), template('out', '{{ pick.count }}/{{ pick.last }}')],
      [edge('list', 'pick'), edge('pick', 'out')],
    ), 1, storage)
    expect(runs.get(1)!.outputs).toEqual({ out: '3/z' })
  })

  it('surfaces thrown errors with console output attached', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow([code('bad', 'console.log("before"); throw new Error("nope")')], []), 1, storage)
    const error = runs.get(1)!.nodeResults.get('bad')?.error ?? ''
    expect(error).toContain('nope')
    expect(error).toContain('before')
  })

  it('has no require or process', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow([code('probe', 'return typeof require + "/" + typeof process')], []), 1, storage)
    expect(runs.get(1)!.outputs).toEqual({ probe: 'undefined/undefined' })
  })
})

describe('if node', () => {
  const branchy = (result: string) => workflow(
    [
      input('result', result),
      ifNode('check', [{ id: 'pass', expression: 'result.passed' }]),
      template('on_pass', 'PASS'),
      template('on_else', 'FIX'),
      template('join', '{{ on_pass or on_else }}'),
    ],
    [
      edge('result', 'check'),
      edge('check', 'on_pass', 'pass'),
      edge('check', 'on_else', 'else'),
      edge('on_pass', 'join'),
      edge('on_else', 'join'),
    ],
  )

  it('runs only the matching branch and skips the other', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(branchy('{"passed": true}'), 1, storage)
    const run = runs.get(1)!
    expect(run.status).toBe('success')
    expect(run.nodeResults.get('check')?.output).toBe('pass')
    expect(run.nodeResults.get('on_pass')?.status).toBe('success')
    expect(run.nodeResults.get('on_else')?.status).toBe('skipped')
    expect(run.outputs).toEqual({ join: 'PASS' })
  })

  it('falls through to else and the fan-in still merges', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(branchy('{"passed": false}'), 1, storage)
    const run = runs.get(1)!
    expect(run.nodeResults.get('on_pass')?.status).toBe('skipped')
    expect(run.nodeResults.get('on_else')?.status).toBe('success')
    expect(run.outputs).toEqual({ join: 'FIX' })
  })

  it('picks the first matching case in order', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [input('n', '{"v": 7}'), ifNode('sw', [{ id: 'small', expression: 'n.v < 5' }, { id: 'mid', expression: 'n.v < 10' }, { id: 'big', expression: 'true' }])],
      [edge('n', 'sw')],
    ), 1, storage)
    expect(runs.get(1)!.outputs).toEqual({ sw: 'mid' })
  })

  it('fails the node instead of silently taking else on a bad expression', async () => {
    const { storage, runs } = createFakeStorage()
    await executeCanvasWorkflow(workflow(
      [ifNode('sw', [{ id: 'a', expression: 'this is not valid ((' }])],
      [],
    ), 1, storage)
    expect(runs.get(1)!.nodeResults.get('sw')?.status).toBe('error')
  })
})
