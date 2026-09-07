import { Hono } from 'hono'
import type { CanvasWorkflowStorageAdapter, ChatStorageAdapter, NotificationStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'
import {
  GROUP_NODE_TYPES,
  IF_ELSE_HANDLE,
  MAX_LOOP_ITERATIONS,
  type CanvasEdge,
  type CanvasLoopNodeData,
  type CanvasSubWorkflowNodeData,
  type CanvasIfNodeData,
  type CanvasNode,
  type CreateCanvasWorkflowInput,
  type UpdateCanvasWorkflowInput,
} from '../types/canvas-workflow.js'
import { startCanvasWorkflowExecution } from '../services/canvas-workflow/index.js'
import { decideApproval } from '../services/canvas-workflow/approvals.js'
import { validateTemplates } from '../services/canvas-workflow/validate.js'

function validateNodeNames(nodes: CanvasNode[]): string | null {
  const seen = new Map<string, string>()

  for (const node of nodes) {
    const trimmedName = node.name.trim()
    if (trimmedName.length === 0) {
      return `Node "${node.id}" name cannot be empty`
    }

    const normalized = trimmedName.toLowerCase()
    const existing = seen.get(normalized)
    if (existing) {
      return `Node name must be unique: "${trimmedName}" duplicates "${existing}"`
    }

    seen.set(normalized, trimmedName)
  }

  return null
}

/**
 * Branch edges must leave an IF node on a handle it actually has; anything
 * else would silently never be taken at run time.
 */
function validateBranches(nodes: CanvasNode[], edges: CanvasEdge[]): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (node.type !== 'if') continue
    const seen = new Set<string>()
    for (const branch of (node.data as CanvasIfNodeData).cases ?? []) {
      if (!branch.id || branch.id === IF_ELSE_HANDLE || seen.has(branch.id)) {
        return `Node "${node.name}" has an invalid or duplicate case id "${branch.id}"`
      }
      seen.add(branch.id)
    }
  }
  for (const edge of edges) {
    if (edge.sourceHandle === undefined) continue
    const source = byId.get(edge.source)
    if (!source || source.type !== 'if') {
      return `Edge "${edge.id}" uses a branch handle but its source is not an If/Else node`
    }
    const handles = new Set([IF_ELSE_HANDLE, ...((source.data as CanvasIfNodeData).cases ?? []).map((c) => c.id)])
    if (!handles.has(edge.sourceHandle)) {
      return `Edge "${edge.id}" leaves "${source.name}" on unknown branch "${edge.sourceHandle}"`
    }
  }
  return null
}

/**
 * Groups are one level deep and edges never cross their border: a body node
 * talks to body nodes, the outside talks to the group node. Anything else has
 * no execution meaning, so it is refused at save time rather than ignored.
 */
function validateGroups(nodes: CanvasNode[], edges: CanvasEdge[]): string | null {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const isGroup = (node: CanvasNode | undefined) =>
    node !== undefined && (GROUP_NODE_TYPES as readonly string[]).includes(node.type)

  for (const node of nodes) {
    if (node.parentId === undefined) continue
    const parent = byId.get(node.parentId)
    if (!isGroup(parent)) return `Node "${node.name}" is inside "${node.parentId}", which is not a group`
    if (isGroup(node)) return `Group "${node.name}" cannot be nested inside another group`
    if (node.type === 'end') return `End node "${node.name}" cannot be inside a group`
  }
  for (const edge of edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target) continue
    if (source.parentId !== target.parentId) {
      return `Edge "${edge.id}" crosses a group border (connect to the group node instead)`
    }
  }
  for (const node of nodes) {
    if (node.type !== 'loop') continue
    const max = (node.data as CanvasLoopNodeData).maxIterations
    if (typeof max !== 'number' || !Number.isFinite(max) || max < 1) {
      return `Loop "${node.name}" needs a max iterations value of at least 1`
    }
    if (max > MAX_LOOP_ITERATIONS) return `Loop "${node.name}" max iterations cannot exceed ${MAX_LOOP_ITERATIONS}`
  }
  return null
}

type CanvasRouteStorage = CanvasWorkflowStorageAdapter & ChatStorageAdapter & ProjectStorageAdapter & NotificationStorageAdapter

function subWorkflowRefs(nodes: CanvasNode[]): number[] {
  return nodes
    .filter((node) => node.type === 'subworkflow')
    .map((node) => (node.data as CanvasSubWorkflowNodeData).workflowId)
    .filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
}

/**
 * Follow sub-workflow references from `nodes` through stored workflows; a
 * path back to `selfId` would loop forever at run time.
 */
function validateSubWorkflows(storage: CanvasRouteStorage, selfId: number | undefined, nodes: CanvasNode[]): string | null {
  const stack = [...subWorkflowRefs(nodes)]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (selfId !== undefined && id === selfId) return 'Sub-workflow reference would create a cycle back to this workflow'
    if (seen.has(id)) continue
    seen.add(id)
    const child = storage.getCanvasWorkflow(id)
    if (!child) return `Sub-workflow ${id} does not exist`
    stack.push(...subWorkflowRefs(child.nodes))
  }
  return null
}

export function canvasWorkflowRoutes(storage: CanvasRouteStorage) {
  const router = new Hono()

  // List workflows
  router.get('/', (c) => {
    const workspaceIdStr = c.req.query('workspaceId')
    const workspaceId = workspaceIdStr ? parseInt(workspaceIdStr, 10) : undefined
    const workflows = storage.listCanvasWorkflows(workspaceId)
    return c.json({ workflows })
  })

  // Get workflow by id
  router.get('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const workflow = storage.getCanvasWorkflow(id)
    if (!workflow) return c.json({ error: 'Not found' }, 404)
    return c.json({ workflow })
  })

  // Create workflow
  router.post('/', async (c) => {
    const input = await c.req.json<CreateCanvasWorkflowInput>()
    const nameError = validateNodeNames(input.nodes)
      ?? validateBranches(input.nodes, input.edges ?? [])
      ?? validateGroups(input.nodes, input.edges ?? [])
      ?? validateSubWorkflows(storage, undefined, input.nodes)
      ?? validateTemplates(input.nodes)
    if (nameError) return c.json({ error: nameError }, 400)
    const workflow = storage.createCanvasWorkflow(input)
    return c.json({ workflow })
  })

  // Update workflow
  router.put('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const updates = await c.req.json<UpdateCanvasWorkflowInput>()
    if (updates.nodes || updates.edges) {
      const existing = storage.getCanvasWorkflow(id)
      if (!existing) return c.json({ error: 'Not found' }, 404)
      const nodes = updates.nodes ?? existing.nodes
      const edges = updates.edges ?? existing.edges
      const validationError = validateNodeNames(nodes)
        ?? validateBranches(nodes, edges)
        ?? validateGroups(nodes, edges)
        ?? validateSubWorkflows(storage, id, nodes)
        ?? validateTemplates(nodes)
      if (validationError) return c.json({ error: validationError }, 400)
    }
    storage.updateCanvasWorkflow(id, updates)
    const workflow = storage.getCanvasWorkflow(id)
    return c.json({ workflow })
  })

  // Delete workflow — refused while another workflow calls it as a sub-workflow.
  router.delete('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const referrers = storage.listCanvasWorkflows()
      .filter((w) => w.id !== id && subWorkflowRefs(w.nodes).includes(id))
      .map((w) => w.name)
    if (referrers.length > 0) {
      return c.json({ error: `Used as a sub-workflow by: ${referrers.join(', ')}`, referrers }, 409)
    }
    storage.deleteCanvasWorkflow(id)
    return c.json({ success: true })
  })

  // Settle an approval node that is waiting on a person
  router.post('/runs/:runId/nodes/:nodeId/decide', async (c) => {
    const runId = parseInt(c.req.param('runId'), 10)
    const nodeId = c.req.param('nodeId')
    const body = await c.req.json<{ approved?: boolean; comment?: string }>().catch(() => ({} as { approved?: boolean; comment?: string }))
    if (typeof body.approved !== 'boolean') return c.json({ error: 'approved (boolean) is required' }, 400)
    const settled = decideApproval(runId, nodeId, { approved: body.approved, comment: body.comment })
    if (!settled) return c.json({ error: 'Nothing is waiting for a decision on this node' }, 404)
    return c.json({ success: true })
  })

  // Execute workflow
  router.post('/:id/execute', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    try {
      const { runId } = startCanvasWorkflowExecution(storage, id)
      return c.json({ runId })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  // Who calls this workflow as a sub-workflow, and which variables they pass.
  // Lets the child's variable picker offer names it never declared itself.
  router.get('/:id/callers', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const callers = storage.listCanvasWorkflows().flatMap((w) =>
      w.nodes
        .filter((node) => node.type === 'subworkflow' && (node.data as CanvasSubWorkflowNodeData).workflowId === id)
        .map((node) => ({
          workflowId: w.id,
          workflowName: w.name,
          nodeName: node.name,
          keys: ((node.data as CanvasSubWorkflowNodeData).inputs ?? []).map((i) => i.key.trim()).filter(Boolean),
        }))
    )
    return c.json({ callers })
  })

  // Child runs (iteration / loop bodies, sub-workflows) of a run
  router.get('/runs/:runId/children', (c) => {
    const runId = parseInt(c.req.param('runId'), 10)
    return c.json({ runs: storage.listCanvasChildRuns(runId) })
  })

  // Get run by id
  router.get('/runs/:runId', (c) => {
    const runId = parseInt(c.req.param('runId'), 10)
    const run = storage.getCanvasRun(runId)
    if (!run) return c.json({ error: 'Not found' }, 404)
    return c.json({ run })
  })

  // List runs for a workflow
  router.get('/:id/runs', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const limit = parseInt(c.req.query('limit') || '20', 10)
    const runs = storage.listCanvasRuns(id, limit)
    return c.json({ runs })
  })

  return router
}
