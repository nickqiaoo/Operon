/**
 * Task board MCP tool names — the single source of truth for the server that
 * registers them (routes/task-board-mcp.ts) and the chat transcript that renders
 * them (components/editor/components/TaskCreatedRenderer.tsx).
 *
 * These names are a contract, not free text: renaming one should be a compile
 * error at every use site, never a silently dead branch in the UI.
 */
export const TASKBOARD_TOOLS = {
  listProjectTasks: 'list_project_tasks',
  getProjectTask: 'get_project_task',
  dispatchProjectTask: 'dispatch_project_task',
  updateProjectTask: 'update_project_task',
  commentProjectTask: 'comment_project_task',
  startSpec: 'start_spec',
  answerSpecQuestions: 'answer_spec_questions',
  submitPullRequest: 'submit_pull_request',
} as const

export type TaskboardToolName = (typeof TASKBOARD_TOOLS)[keyof typeof TASKBOARD_TOOLS]

/**
 * Task-creating tools that are no longer registered, but still appear in stored
 * transcripts — `create_task` / `promote_to_task` predate the `*_project_task`
 * rename, `create_project_task` was removed outright (agent-initiated work goes
 * through a spec; plain tasks are created by people in the UI), and
 * `create_spec_task` was the SDD v2 entry that `start_spec` replaced. The
 * renderer still recognises them so scrolling back through old conversations
 * keeps working. Retired names only, never new ones.
 */
export const LEGACY_TASK_CREATING_TOOLS = [
  'create_task',
  'promote_to_task',
  'create_project_task',
  'create_spec_task',
] as const

/**
 * Tools whose successful result announces a newly created task. The renderer
 * turns those calls into a card that links to the task's detail page.
 */
export const TASK_CREATING_TOOLS: readonly string[] = [
  TASKBOARD_TOOLS.startSpec,
  ...LEGACY_TASK_CREATING_TOOLS,
]

/**
 * Machine-readable payload a task-creating tool puts in the MCP result's
 * `structuredContent`, alongside the prose the model reads.
 *
 * The prose is written for the model and will keep being reworded; the UI must
 * not have to parse it to learn which task was created. `taskId` is the database
 * id the task page opens by — deliberately absent from the prose, where it would
 * be noise to the model.
 */
export interface CreatedTaskRef {
  kind: 'created-task'
  taskId: number
  taskNumber: number
  title: string
  /** SDD v2 spec task — only in transcripts from before OperonSpec. */
  sddManaged?: boolean
  /** An OperonSpec parent: the card shows its live stage and the design gate. */
  spec?: boolean
}

/** Narrow an unknown `structuredContent` to a CreatedTaskRef. */
export function asCreatedTaskRef(value: unknown): CreatedTaskRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind !== 'created-task') return null
  if (typeof v.taskId !== 'number' || typeof v.taskNumber !== 'number') return null
  return {
    kind: 'created-task',
    taskId: v.taskId,
    taskNumber: v.taskNumber,
    title: typeof v.title === 'string' ? v.title : '',
    sddManaged: v.sddManaged === true,
    spec: v.spec === true,
  }
}

/** True for the SDD v2 spec-driven tools, which get their own label on the plain card. */
export function isSpecTaskTool(name: string): boolean {
  return name === 'create_spec_task' || name === 'promote_to_task'
}

/** True for the OperonSpec entry, whose card shows the spec's live stage. */
export function isOperonSpecTool(name: string): boolean {
  return name === TASKBOARD_TOOLS.startSpec
}

/**
 * An MCP client prefixes tool names with its server handle — real transcripts
 * carry `mcp__task_board__create_task`, and the gateway path adds its own layer.
 * That prefix is imposed by the client, not by us, so strip it before comparing
 * against the contract above.
 */
export function bareToolName(name: string | undefined): string {
  if (!name) return ''
  const parts = name.split('__')
  return parts[parts.length - 1] || name
}
