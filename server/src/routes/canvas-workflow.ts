import { Hono } from 'hono'
import type { CanvasWorkflowStorageAdapter, ChatStorageAdapter, ProjectStorageAdapter } from '../storage/interface.js'
import type { CanvasNode, CreateCanvasWorkflowInput, UpdateCanvasWorkflowInput } from '../types/canvas-workflow.js'
import { startCanvasWorkflowExecution } from '../services/canvas-workflow.js'

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

export function canvasWorkflowRoutes(storage: CanvasWorkflowStorageAdapter & ChatStorageAdapter & ProjectStorageAdapter) {
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
    if (nameError) return c.json({ error: nameError }, 400)
    const workflow = storage.createCanvasWorkflow(input)
    return c.json({ workflow })
  })

  // Update workflow
  router.put('/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10)
    const updates = await c.req.json<UpdateCanvasWorkflowInput>()
    if (updates.nodes) {
      const nameError = validateNodeNames(updates.nodes)
      if (nameError) return c.json({ error: nameError }, 400)
    }
    storage.updateCanvasWorkflow(id, updates)
    const workflow = storage.getCanvasWorkflow(id)
    return c.json({ workflow })
  })

  // Delete workflow
  router.delete('/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10)
    storage.deleteCanvasWorkflow(id)
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
