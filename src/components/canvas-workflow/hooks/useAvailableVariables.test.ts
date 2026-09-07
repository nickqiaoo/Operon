import { describe, it, expect } from 'vitest'
import { computeAvailableVariables, rootNames } from './useAvailableVariables'
import type { CanvasNode } from '@/components/canvas-workflow/utils/canvasConversions'
import type { CanvasWorkflowRun } from '@/types/canvas-workflow'

const node = (id: string, name: string, type = 'templateNode', parentId?: string): CanvasNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { name, nodeData: {} }, ...(parentId ? { parentId } : {}) })
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })

describe('computeAvailableVariables', () => {
  const nodes = [
    node('a', 'first step'),
    node('b', 'review'),
    node('c', 'unrelated'),
    node('d', 'consumer'),
    node('g', 'each', 'iterationNode'),
    node('inner', 'inside', 'templateNode', 'g'),
  ]
  const edges = [edge('a', 'b'), edge('b', 'd'), edge('c', 'c'), edge('b', 'g')]

  it('lists transitive upstream nodes only, with sanitized names', () => {
    const vars = computeAvailableVariables('d', nodes, edges, null)
    expect(vars.map((v) => v.path)).toEqual(['review', 'first_step', 'env'])
  })

  it('expands JSON fields from the last run', () => {
    const run = { nodeResults: [{ nodeId: 'b', status: 'success', output: '{"passed": true, "issues": ["x"]}' }] } as unknown as CanvasWorkflowRun
    const review = computeAvailableVariables('d', nodes, edges, run).find((v) => v.path === 'review')!
    expect(review.children?.map((c) => c.path)).toEqual(['review.passed', 'review.issues'])
    expect(review.children?.[1].children?.[0].path).toBe('review.issues[0]')
  })

  it('inside a group sees item/index and the group\'s upstream, not the group itself', () => {
    const vars = computeAvailableVariables('inner', nodes, edges, null)
    const paths = vars.map((v) => v.path)
    expect(paths).toContain('item')
    expect(paths).toContain('index')
    expect(paths).toContain('review')
    expect(paths).not.toContain('each')
    expect(rootNames(vars)).toEqual(new Set(['review', 'first_step', 'item', 'index', 'env']))
  })
})
