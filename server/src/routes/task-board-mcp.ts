/**
 * Project task board MCP server.
 *
 * This server owns project-level task tools. It intentionally does not expose
 * chat tools and does not use legacy channel-message task APIs.
 */

import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../storage/interface.js'
import { TaskBoardService, type ToolResult } from '../services/agent-comm/task-board-service.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'
import type { ArtifactKind, TaskPriority, TaskStatus } from '../types/task.js'
import { TASKBOARD_TOOLS } from '@shared/taskboard/tools'

const TOOLS: Tool[] = [
  {
    name: TASKBOARD_TOOLS.listProjectTasks,
    description:
      "List durable, shared tasks on this project's Taskboard. These are project records, not the agent runtime's private task or todo list. Optionally filter by status, priority, or assignee. Check this before creating or dispatching so you do not duplicate work.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'in_review', 'done', 'cancelled'],
          description: 'Filter by status',
        },
        priority: {
          type: 'number',
          description: 'Filter by priority: 0 none, 1 low, 2 medium, 3 high, 4 urgent',
        },
        assignee_agent_id: {
          type: 'number',
          description: 'Filter to tasks assigned to this agent id',
        },
      },
    },
  },
  {
    name: TASKBOARD_TOOLS.getProjectTask,
    description:
      "Read one shared project task in full: description, labels, assignee, branch, and activity feed. Use this before working on a Taskboard task.",
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'number', description: 'Task number, e.g. 42' } },
      required: ['task'],
    },
  },
  {
    name: TASKBOARD_TOOLS.dispatchProjectTask,
    description:
      'Dispatch a task to the confirmed assignee agent. The caller is the operator; assignee is the worker name, such as "@builder" or "builder". This assigns that agent, moves a todo task to in_progress, and starts the task-scoped execution session in its dedicated worktree. Use only after the user confirms the assignee.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Task number to dispatch' },
        assignee: {
          type: 'string',
          description: 'Agent name that should run the task, with or without @',
        },
      },
      required: ['task', 'assignee'],
    },
  },
  {
    name: TASKBOARD_TOOLS.updateProjectTask,
    description:
      'Update a shared project task you own on the Taskboard. You must be the assignee to change status. Use in_review when work is ready for human validation; done is a human review action.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Task number to update' },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'in_review', 'done', 'cancelled'],
          description: 'New status',
        },
        priority: { type: 'number', description: '0 none, 1 low, 2 medium, 3 high, 4 urgent' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['task'],
    },
  },
  {
    name: TASKBOARD_TOOLS.commentProjectTask,
    description:
      "Post a progress update or comment to a shared project task's activity feed.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Task number' },
        body: { type: 'string', description: 'The comment or progress text (Markdown ok)' },
      },
      required: ['task', 'body'],
    },
  },
  {
    name: TASKBOARD_TOOLS.createSpecTask,
    description:
      'SDD: create a spec-driven task from a converged channel discussion. Use ONLY once the design is agreed and the user confirms YOU should create it. If the user has not named the creator, ask first. The channel is taken from your current session — you do not (and cannot) pass it. Creates the task + change branch and makes YOU the spec author; then write the spec with write_artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        message_id: { type: 'number', description: 'Source message id (optional)' },
        description: { type: 'string', description: 'Short summary (optional)' },
      },
      required: ['title'],
    },
    // Declared so the structured half of the result is a contract, not a payload
    // a client may or may not bother to carry. `taskId` is the database id, which
    // deliberately never appears in the prose (noise to a model, essential to a UI).
    // A failed call returns isError with prose only — there is no task to describe.
    outputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'created-task' },
        taskId: { type: 'number', description: 'Database id — open the task detail page by this' },
        taskNumber: { type: 'number', description: 'Per-project number shown as #N' },
        title: { type: 'string' },
        sddManaged: { type: 'boolean' },
      },
      required: ['kind', 'taskId', 'taskNumber'],
    },
  },
  {
    name: TASKBOARD_TOOLS.writeArtifact,
    description:
      "SDD: write an artifact file onto the task's change branch. spec/plan are the author's, written before Dispatch (you must be the task's spec author); acceptance is the verifier's report on a finished change, written only if you were dispatched as its verifier. A fresh write lands as draft and needs human approval (Gate-0) before work can start.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Task number' },
        kind: {
          type: 'string',
          enum: ['spec', 'plan', 'acceptance', 'spec_delta'],
          description:
            'Which artifact to write. spec_delta = this change\'s delta against the living spec — one or more `## Capability: <name>` sections, each with ADDED/MODIFIED/REMOVED/RENAMED Requirements (requirements matched by `### Requirement:` header text). A brand-new capability is an all-ADDED delta.',
        },
        content: { type: 'string', description: 'Full markdown content of the artifact' },
      },
      required: ['task', 'kind', 'content'],
    },
  },
  {
    name: TASKBOARD_TOOLS.sedimentChange,
    description:
      "SDD: apply this change's spec_delta into the living spec(s) on the default branch (§13). For each `## Capability:` in the delta, reads that capability's current living spec as base and applies ADDED/MODIFIED/REMOVED/RENAMED matched by `### Requirement:` header text (a new capability bootstraps from empty). Defaults to a dry-run preview; pass apply:true to write onto the change branch. Semantic conflicts (e.g. MODIFIED a requirement whose header doesn't exist) halt for a human.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Parent task number to sediment' },
        apply: { type: 'boolean', description: 'Write the result (default false = preview only)' },
      },
      required: ['task'],
    },
  },
]

type TaskBoardRouteStorage = TaskStorageAdapter &
  ChannelStorageAdapter &
  ProjectStorageAdapter &
  NotificationStorageAdapter

function buildTaskBoardMcpServer(board: TaskBoardService, agentId: number): Server {
  const server = new Server(
    { name: 'taskboard', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  // All board tools — including the SDD tools (create_spec_task / write_artifact /
  // sediment_change) — are always listed. SDD is not a pre-armed channel "mode": a
  // discussion becomes a spec-driven change when the agent calls create_spec_task,
  // and every SDD tool validates its own context at call time (promote needs a
  // channel session; write/sediment need an existing spec task + author).
  // Decomposition is deliberately NOT an agent tool: approve+decompose happen
  // atomically when the human presses Dispatch (routes/task.ts prepareSddParent),
  // so an agent could never call it at a moment when it would succeed.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      const result = await dispatch(name, (args ?? {}) as Record<string, unknown>, board, agentId)
      // Two channels, on purpose: `content` is the prose the model reads, and
      // `structuredContent` is the same event in machine-readable form for the UI.
      // Reworded prose must never break a client that only wants the ids.
      if (typeof result === 'string') return { content: [{ type: 'text', text: result }] }
      return {
        content: [{ type: 'text', text: result.text }],
        ...(result.structured ? { structuredContent: result.structured } : {}),
        ...(result.isError ? { isError: true } : {}),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    }
  })

  return withCodexElicitationFallback(server)
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  board: TaskBoardService,
  agentId: number,
): Promise<string | ToolResult> {
  switch (name) {
    case TASKBOARD_TOOLS.listProjectTasks:
      return board.list({
        status: typeof args.status === 'string' ? (args.status as TaskStatus) : undefined,
        priority: typeof args.priority === 'number' ? (args.priority as TaskPriority) : undefined,
        assignedAgentId:
          typeof args.assignee_agent_id === 'number' ? args.assignee_agent_id : undefined,
      })

    case TASKBOARD_TOOLS.getProjectTask:
      return board.get(Number(args.task))

    case TASKBOARD_TOOLS.dispatchProjectTask:
      return board.dispatchTask(Number(args.task), String(args.assignee), agentId)

    case TASKBOARD_TOOLS.updateProjectTask:
      return board.update(
        Number(args.task),
        {
          status: typeof args.status === 'string' ? (args.status as TaskStatus) : undefined,
          priority: typeof args.priority === 'number' ? (args.priority as TaskPriority) : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          description: typeof args.description === 'string' ? args.description : undefined,
        },
        agentId,
      )

    case TASKBOARD_TOOLS.commentProjectTask:
      return board.comment(Number(args.task), String(args.body), agentId)

    case TASKBOARD_TOOLS.createSpecTask:
      return board.createSpecTask(
        {
          messageId: typeof args.message_id === 'number' ? args.message_id : null,
          title: String(args.title),
          description: typeof args.description === 'string' ? args.description : undefined,
        },
        agentId,
      )

    case TASKBOARD_TOOLS.writeArtifact:
      return board.writeArtifact(
        Number(args.task),
        args.kind as ArtifactKind,
        String(args.content),
        agentId,
      )

    case TASKBOARD_TOOLS.sedimentChange:
      return board.sediment(Number(args.task), args.apply === true, agentId)

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export function taskBoardMcpRoutes(storage: TaskBoardRouteStorage) {
  const router = new Hono()

  const handle = async (c: Context) => {
    const agentId = parseInt(c.req.header('x-agent-id') ?? c.req.query('agentId') ?? '0', 10)
    const projectId = parseInt(c.req.header('x-project-id') ?? c.req.query('projectId') ?? '0', 10)
    if (!agentId || !projectId) {
      console.warn('[task-board-mcp] Missing X-Agent-Id/X-Project-Id (header or query)')
      return c.json({ error: 'agentId and projectId required (header or query)' }, 400)
    }
    // SDD promote source, derived from the session URL (set by mcp-config), never
    // from a model argument — this is how create_spec_task knows what it's turning
    // into a spec-driven task. channelId = a channel agent; sourceChatId = a direct
    // user chat (mutually exclusive). Both absent for non-promotable sessions
    // (task execution, IM).
    const channelIdRaw = c.req.query('channelId')
    const channelId = channelIdRaw ? parseInt(channelIdRaw, 10) : undefined
    const sourceChatIdRaw = c.req.query('sourceChatId')
    const sourceChatId = sourceChatIdRaw ? parseInt(sourceChatIdRaw, 10) : undefined
    console.log(
      `[task-board-mcp] agent=${agentId} ${c.req.method} channel=${channelId ?? '-'} chat=${sourceChatId ?? '-'}`,
    )
    const board = new TaskBoardService(storage, projectId, channelId, sourceChatId)
    return serveMcpOverHono(c, buildTaskBoardMcpServer(board, agentId))
  }

  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  return router
}
