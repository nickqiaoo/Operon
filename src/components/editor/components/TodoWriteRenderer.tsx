import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '@/components/ai-elements/queue';
import { Tool, ToolHeader, ToolContent } from '@/components/ai-elements/tool';
import { getToolDisplayName, type ToolPartLike } from './toolName';
import { normalizeToolState } from './toolState';

export interface TodoEntry {
  id?: string;
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isTodoStatus = (value: unknown): value is TodoEntry['status'] =>
  value === 'pending' || value === 'in_progress' || value === 'completed';

const isTodoEntry = (value: unknown): value is TodoEntry => {
  if (!isRecord(value)) return false;
  if (value.id !== undefined && typeof value.id !== 'string') return false;
  if (typeof value.content !== 'string') return false;
  if (!isTodoStatus(value.status)) return false;
  return value.activeForm === undefined || typeof value.activeForm === 'string';
};

const asTodoEntries = (value: unknown): TodoEntry[] =>
  Array.isArray(value) ? value.filter(isTodoEntry) : [];

interface TodoWriteRendererProps {
  toolPart: ToolPartLike & {
    state?: string;
    result?: unknown;
    output?: unknown;
  };
  messageId: string;
  partIndex: number;
}

const TASK_TOOL_NAMES = new Set([
  'todowrite', 'tool-todowrite',
  'taskcreate', 'tool-taskcreate',
  'taskupdate', 'tool-taskupdate',
  'taskget', 'tool-taskget',
  'tasklist', 'tool-tasklist',
  'codex_plan_steps',
]);

export function isTodoWriteTool(toolPart: ToolPartLike): boolean {
  const toolName = getToolDisplayName(toolPart).toLowerCase();
  return TASK_TOOL_NAMES.has(toolName);
}

function getToolOutput(toolPart: ToolPartLike): unknown {
  const part = toolPart as { result?: unknown; output?: unknown };
  return part.result ?? part.output;
}

function parseOutputRecord(output: unknown): Record<string, unknown> | null {
  if (isRecord(output)) return output;
  if (typeof output !== 'string') return null;
  try {
    const parsed = JSON.parse(output);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getCreatedTaskId(toolPart: ToolPartLike): string | undefined {
  const output = getToolOutput(toolPart);
  const record = parseOutputRecord(output);
  const task = record?.task;
  if (isRecord(task) && (typeof task.id === 'string' || typeof task.id === 'number')) {
    return String(task.id);
  }

  if (typeof output === 'string') {
    const match = output.match(/Task #([^\s]+) created successfully:/i);
    if (match) return match[1];
  }

  const toolCallId = (toolPart as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === 'string' ? `call:${toolCallId}` : undefined;
}

function extractTaskRecordTodos(toolPart: ToolPartLike): TodoEntry[] {
  const rawInput = (toolPart.args || toolPart.input || {}) as Record<string, unknown>;
  const toolName = getToolDisplayName(toolPart).toLowerCase().replace('tool-', '');

  if (toolName === 'taskcreate') {
    const subject = rawInput.subject as string | undefined;
    const activeForm = rawInput.activeForm as string | undefined;
    return subject ? [{
      id: getCreatedTaskId(toolPart),
      content: subject,
      activeForm: activeForm ?? undefined,
      status: 'pending',
    }] : [];
  }

  if (toolName === 'taskupdate') {
    const subject = rawInput.subject as string | undefined;
    const taskId = rawInput.taskId as string | undefined;
    const status = rawInput.status as string | undefined;
    const mappedStatus: TodoEntry['status'] =
      status === 'completed' ? 'completed'
        : status === 'in_progress' ? 'in_progress'
          : 'pending';
    const label = subject || (taskId ? `Task #${taskId}` : 'Task');
    return [{ id: taskId, content: label, status: mappedStatus }];
  }

  if (toolName === 'tasklist') {
    // Parse result to show task list
    const output = getToolOutput(toolPart);
    if (!output) return [];
    let parsed: { tasks?: Array<{ id?: string | number; subject?: string; status?: string }> } | undefined;
    try {
      parsed = typeof output === 'string' ? JSON.parse(output) : output as typeof parsed;
    } catch { return []; }
    return (parsed?.tasks ?? []).map((t) => ({
      id: t.id === undefined ? undefined : String(t.id),
      content: t.subject ?? 'Task',
      status: t.status === 'completed' ? 'completed' as const
        : t.status === 'in_progress' ? 'in_progress' as const
          : 'pending' as const,
    }));
  }

  if (toolName === 'taskget') {
    const output = getToolOutput(toolPart);
    if (!output) return [];
    let parsed: { task?: { id?: string | number; subject?: string; status?: string } } | undefined;
    try {
      parsed = typeof output === 'string' ? JSON.parse(output) : output as typeof parsed;
    } catch { return []; }
    if (!parsed?.task) return [];
    const t = parsed.task;
    return [{
      id: t.id === undefined ? undefined : String(t.id),
      content: t.subject ?? 'Task',
      status: t.status === 'completed' ? 'completed' as const
        : t.status === 'in_progress' ? 'in_progress' as const
          : 'pending' as const,
    }];
  }

  return [];
}

function extractCodexPlanStepTodos(toolPart: ToolPartLike): TodoEntry[] {
  const rawInput = (toolPart.args || toolPart.input || {}) as Record<string, unknown>;
  const output = (toolPart as { result?: unknown; output?: unknown }).result
    ?? (toolPart as { result?: unknown; output?: unknown }).output;
  const source = (output ?? rawInput) as { steps?: Array<{ step: string; status: string }> };
  if (!source?.steps) return [];
  return source.steps.map((s) => ({
    content: s.step,
    status: s.status === 'completed' ? 'completed' as const
      : s.status === 'inProgress' ? 'in_progress' as const
        : 'pending' as const,
  }));
}

export function extractTodosFromPart(toolPart: ToolPartLike): TodoEntry[] {
  const rawInput = (toolPart.args || toolPart.input || {}) as {
    todos?: unknown;
  };
  const todos = asTodoEntries(rawInput.todos);
  if (todos.length > 0) return todos;
  const toolName = getToolDisplayName(toolPart).toLowerCase().replace('tool-', '');
  if (toolName === 'codex_plan_steps') return extractCodexPlanStepTodos(toolPart);
  return extractTaskRecordTodos(toolPart);
}

export function TodoWriteRenderer({
  toolPart,
  messageId,
  partIndex,
}: TodoWriteRendererProps) {
  const state = normalizeToolState(toolPart.state);
  const toolName = getToolDisplayName(toolPart);
  const todos = extractTodosFromPart(toolPart);

  if (todos.length === 0) {
    return (
      <Tool key={`${messageId}-${partIndex}`}>
        <ToolHeader type="dynamic-tool" toolName={toolName} state={state} />
      </Tool>
    );
  }

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
  const allCompleted = completedCount === todos.length;

  const label = allCompleted
    ? 'tasks completed'
    : inProgressCount > 0
      ? `tasks (${completedCount}/${todos.length} done)`
      : 'tasks';

  return (
    <Tool key={`${messageId}-${partIndex}`}>
      <ToolHeader type="dynamic-tool" toolName={toolName} state={state} />
      <ToolContent>
        <Queue className="border-0 shadow-none px-0 pt-0 pb-0">
          <QueueSection defaultOpen={!allCompleted}>
            <QueueSectionTrigger>
              <QueueSectionLabel
                count={allCompleted ? completedCount : todos.length}
                label={label}
              />
            </QueueSectionTrigger>
            <QueueSectionContent>
              <div>
                {todos.map((entry, k) => {
                  const isCompleted = entry.status === 'completed';
                  const isInProgress = entry.status === 'in_progress';
                  const displayText = isInProgress && entry.activeForm
                    ? entry.activeForm
                    : entry.content;

                  return (
                    <QueueItem key={k}>
                      <div className="flex items-center gap-2">
                        <QueueItemIndicator
                          completed={isCompleted}
                          inProgress={isInProgress}
                        />
                        <QueueItemContent completed={isCompleted}>
                          {displayText}
                        </QueueItemContent>
                      </div>
                    </QueueItem>
                  );
                })}
              </div>
            </QueueSectionContent>
          </QueueSection>
        </Queue>
      </ToolContent>
    </Tool>
  );
}
