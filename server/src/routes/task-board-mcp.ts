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
  AgentBindingStorageAdapter,
  ChannelStorageAdapter,
  NotificationStorageAdapter,
  ProjectStorageAdapter,
  TaskStorageAdapter,
} from '../storage/interface.js'
import { TaskBoardService, type SwitchToolInput, type ToolResult } from '../services/agent-comm/task-board-service.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'
import type { TaskPriority, TaskStatus } from '../types/task.js'
import { TASKBOARD_TOOLS } from '@shared/taskboard/tools'
import { START_SPEC_DESCRIPTION } from '../services/spec/prompts.js'

/** Which seat of a spec a switch moves, and to whom — shared by propose and switch. */
const SWITCH_TARGET = {
  task: { type: 'number', description: 'Spec task number' },
  role: {
    type: 'string',
    enum: ['lead', 'explorer', 'candidate', 'judge', 'builder', 'implementer', 'reviewer', 'coordinator'],
    description: 'The role to move. implementer/reviewer with `ticket` moves one ticket; without it, the spec\'s default for that role',
  },
  ticket: { type: 'number', description: "Optional: the ticket's task number, for one ticket's implementer or reviewer" },
  candidate: { type: 'string', description: 'For role candidate: which one (A, B, …)' },
  provider: { type: 'string', description: 'Agent to move it to — one spec_status lists as usable here' },
  model: { type: 'string', description: "Optional: the model on that agent; omit for the agent's default" },
} as const

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
    name: TASKBOARD_TOOLS.startSpec,
    description: START_SPEC_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title of the change, in the user\'s language' },
        brief: { type: 'string', description: 'The brief, markdown, with exactly the sections listed in the description' },
        candidates: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: provider ids the user named (e.g. ["codex","opencode"]). They become the design candidates AND the only agents used for every other role (judge, builder, explorers, implementers, reviewers), plus this chat\'s own. When the user also named a model for one, write it as "provider:model" (e.g. "opencode:opencode/deepseek-v4.1-flash-free") and every seat of that provider runs on it. Omit to use the defaults — two candidates from different families and a judge from a third.',
        },
      },
      required: ['title', 'brief'],
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
        spec: { type: 'boolean' },
      },
      required: ['kind', 'taskId', 'taskNumber'],
    },
  },
  {
    name: TASKBOARD_TOOLS.answerSpecQuestions,
    description:
      "OperonSpec: pass the user's answers to the questions a spec's design run brought back (they arrive in this chat as a workflow result). Use only with the user's own answers — never answer for them. The design then continues in the background.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Spec task number' },
        answers: { type: 'string', description: "The user's answers, numbered to match the questions" },
      },
      required: ['task', 'answers'],
    },
  },
  {
    name: TASKBOARD_TOOLS.submitPullRequest,
    description:
      'Push the current branch (HEAD) of your task worktree to GitHub and open a pull request for it, or push new commits to the pull request already open for the branch. Commit first: the working tree must be clean. Never targets the default branch. Only the agent assigned to the task may call it; requires the operon GitHub App on the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Task number you are working on' },
        title: { type: 'string', description: 'Pull request title' },
        body: {
          type: 'string',
          description: 'Pull request description in markdown: what changed and why, how it was tested, the Linear issue URL.',
        },
        branch: {
          type: 'string',
          description: 'The branch to push HEAD to and open the PR from (your task branch).',
        },
      },
      required: ['task', 'title', 'body', 'branch'],
    },
  },
  {
    name: TASKBOARD_TOOLS.specStatus,
    description:
      "OperonSpec: where a spec stands — its stage, and every ticket's build state, review rounds, why it is blocked and the issues still open — plus the rulings made so far.",
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'number', description: 'Spec task number' } },
      required: ['task'],
    },
  },
  {
    name: TASKBOARD_TOOLS.specRetryTicket,
    description:
      "OperonSpec coordinator only: set a blocked ticket going again. Its implementer's own session is woken with your instructions; its review rounds start over. Limited retries per ticket — past them, escalate.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Spec task number' },
        ticket: { type: 'number', description: 'Task number of the blocked ticket' },
        instructions: { type: 'string', description: 'What the implementer should do differently, concretely' },
        ruling: {
          type: 'string',
          description: 'Optional: a decision you made where the design was unclear, "…, because …" — recorded for the review and sign-off',
        },
      },
      required: ['task', 'ticket', 'instructions'],
    },
  },
  {
    name: TASKBOARD_TOOLS.specAddTicket,
    description:
      'OperonSpec coordinator only: add a ticket the build is missing — built by an implementer and reviewed by another model family like the others. It must stay within the approved design.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Spec task number' },
        title: { type: 'string' },
        delivers: { type: 'string', description: 'The behaviour it makes work, end to end' },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'Checkable acceptance criteria' },
        blocked_by: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional: task numbers of tickets that must merge before this one starts',
        },
      },
      required: ['task', 'title', 'delivers', 'acceptance'],
    },
  },
  {
    name: TASKBOARD_TOOLS.specEscalate,
    description:
      "OperonSpec coordinator only: hand a decision to the user — a design that does not hold, a ticket that retrying will not fix, a conflict you cannot resolve without changing the change. Say what you found and what you recommend. Their answer comes back as a comment on the spec.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Spec task number' },
        message: { type: 'string', description: "What the user needs to decide, in the brief's language" },
        ticket: { type: 'number', description: 'Task number of the blocked ticket this is about, if it is about one' },
      },
      required: ['task', 'message'],
    },
  },
  {
    name: TASKBOARD_TOOLS.specIntegrationDone,
    description:
      'OperonSpec coordinator only: the sign-off conflict is resolved — the default branch is merged into the change branch and committed, the worktree clean. A reviewer from another model family checks the resolution before the user signs off again.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Spec task number' },
        summary: { type: 'string', description: 'How you resolved each conflicted file, and the checks you ran with their results' },
      },
      required: ['task', 'summary'],
    },
  },
  {
    name: TASKBOARD_TOOLS.specProposeSwitch,
    description:
      "OperonSpec coordinator only: ask the user to move a role to another agent or model — when the agent is the problem (out of quota, rate-limited, not logged in, a provider error, a model that will not start). Nothing changes until the user agrees; then the work carries on on the new agent.",
    inputSchema: {
      type: 'object',
      properties: {
        ...SWITCH_TARGET,
        reason: { type: 'string', description: "Why, in the brief's language: what failed and why the other agent is the fix" },
      },
      required: ['task', 'role', 'provider', 'reason'],
    },
  },
  {
    name: TASKBOARD_TOOLS.specSwitchAgent,
    description:
      "OperonSpec, from the chat the spec was started from: move a role to another agent or model because the user said so (including agreeing to the coordinator's proposal). A ticket's implementer switch hands the ticket over at once; a stopped or failed spec carries on.",
    inputSchema: { type: 'object', properties: SWITCH_TARGET, required: ['task', 'role', 'provider'] },
  },
  {
    name: TASKBOARD_TOOLS.specDeclineSwitch,
    description: "OperonSpec, from the chat the spec was started from: the user turned down the coordinator's proposed switch. The coordinator hears so.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Spec task number' },
        note: { type: 'string', description: 'What the user said instead, if anything' },
      },
      required: ['task'],
    },
  },
  {
    name: TASKBOARD_TOOLS.specMessageCoordinator,
    description:
      "OperonSpec, from the chat the spec was started from: pass the user's words to the spec's coordinator — an answer to what it asked, or something it should do about the build. It acts in the background and comes back here if it needs them.",
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'number', description: 'Spec task number' },
        message: { type: 'string', description: "What the user said, faithfully" },
      },
      required: ['task', 'message'],
    },
  },
]

type TaskBoardRouteStorage = TaskStorageAdapter &
  ChannelStorageAdapter &
  ProjectStorageAdapter &
  NotificationStorageAdapter &
  Pick<AgentBindingStorageAdapter, 'getBinding'>

function switchArgs(args: Record<string, unknown>): SwitchToolInput {
  return {
    role: String(args.role ?? ''),
    ticket: typeof args.ticket === 'number' ? args.ticket : undefined,
    candidate: typeof args.candidate === 'string' ? args.candidate : undefined,
    provider: String(args.provider ?? ''),
    model: typeof args.model === 'string' ? args.model : undefined,
  }
}

function buildTaskBoardMcpServer(board: TaskBoardService, agentId: number): Server {
  const server = new Server(
    { name: 'taskboard', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  // All board tools are always listed. A spec is not a pre-armed "mode": a chat
  // becomes one when its agent calls start_spec, and every spec tool validates its
  // own context at call time (start_spec needs a workspace chat).
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

    case TASKBOARD_TOOLS.startSpec:
      return board.startSpec(
        {
          title: String(args.title ?? ''),
          brief: String(args.brief ?? ''),
          candidates: Array.isArray(args.candidates)
            ? args.candidates.filter((c): c is string => typeof c === 'string')
            : undefined,
        },
        agentId,
      )

    case TASKBOARD_TOOLS.answerSpecQuestions:
      return board.answerSpecQuestions(Number(args.task), String(args.answers ?? ''))

    case TASKBOARD_TOOLS.submitPullRequest:
      return board.submitPullRequest(
        Number(args.task),
        { title: String(args.title ?? ''), body: String(args.body ?? ''), branch: String(args.branch ?? '') },
        agentId,
      )

    case TASKBOARD_TOOLS.specStatus:
      return board.specStatus(Number(args.task))

    case TASKBOARD_TOOLS.specRetryTicket:
      return board.specRetryTicket(
        Number(args.task),
        {
          ticket: Number(args.ticket),
          instructions: String(args.instructions ?? ''),
          ruling: typeof args.ruling === 'string' ? args.ruling : undefined,
        },
        agentId,
      )

    case TASKBOARD_TOOLS.specAddTicket:
      return board.specAddTicket(
        Number(args.task),
        {
          title: String(args.title ?? ''),
          delivers: String(args.delivers ?? ''),
          acceptance: Array.isArray(args.acceptance) ? args.acceptance.filter((a): a is string => typeof a === 'string') : [],
          blockedBy: Array.isArray(args.blocked_by) ? args.blocked_by.map(Number).filter(Number.isFinite) : undefined,
        },
        agentId,
      )

    case TASKBOARD_TOOLS.specEscalate:
      return board.specEscalate(
        Number(args.task),
        String(args.message ?? ''),
        agentId,
        typeof args.ticket === 'number' ? args.ticket : undefined,
      )

    case TASKBOARD_TOOLS.specIntegrationDone:
      return board.specIntegrationDone(Number(args.task), String(args.summary ?? ''), agentId)

    case TASKBOARD_TOOLS.specProposeSwitch:
      return board.specProposeSwitch(Number(args.task), switchArgs(args), String(args.reason ?? ''), agentId)

    case TASKBOARD_TOOLS.specSwitchAgent:
      return board.specSwitchAgent(Number(args.task), switchArgs(args))

    case TASKBOARD_TOOLS.specDeclineSwitch:
      return board.specDeclineSwitch(Number(args.task), typeof args.note === 'string' ? args.note : undefined)

    case TASKBOARD_TOOLS.specMessageCoordinator:
      return board.specMessageCoordinator(Number(args.task), String(args.message ?? ''))

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
    // The session's own chat, from the URL mcp-config built — never a model
    // argument. It is how start_spec knows which conversation to report back to;
    // absent for channel agents, task execution and IM sessions.
    const channelId = c.req.query('channelId')
    const sourceChatIdRaw = c.req.query('sourceChatId')
    const sourceChatId = sourceChatIdRaw ? parseInt(sourceChatIdRaw, 10) : undefined
    console.log(
      `[task-board-mcp] agent=${agentId} ${c.req.method} channel=${channelId ?? '-'} chat=${sourceChatId ?? '-'}`,
    )
    const board = new TaskBoardService(storage, projectId, sourceChatId)
    return serveMcpOverHono(c, buildTaskBoardMcpServer(board, agentId))
  }

  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  return router
}
