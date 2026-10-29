import { ListChecksIcon, ListTodoIcon } from 'lucide-react';
import { useIntl } from 'react-intl';
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
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

/**
 * A todo list as shadcn's Queue: what is left (open), then what is done
 * (closed), each item a line. The in-progress item reads its `activeForm`.
 * Shared by the TodoWrite tool line and the composer's live list.
 */
export function TodoQueue({
  todos,
  live = false,
  className,
}: {
  /**
   * The composer's current list: its in-progress item shimmers. A TodoWrite in
   * the transcript is a snapshot of an earlier moment, so it keeps the
   * in-progress mark without the "working now" shimmer.
   */
  live?: boolean;
  /** `status` loosely typed: the composer's list comes from chat-derived, which keeps it a string. */
  todos: Array<Omit<TodoEntry, 'status'> & { status: TodoEntry['status'] | (string & {}) }>;
  className?: string;
}) {
  const intl = useIntl();
  const left = todos.filter((t) => t.status !== 'completed');
  const done = todos.filter((t) => t.status === 'completed');

  const item = (entry: (typeof todos)[number], k: number) => {
    const completed = entry.status === 'completed';
    const inProgress = entry.status === 'in_progress';
    return (
      <QueueItem key={entry.id ?? k} completed={completed} inProgress={live && inProgress}>
        <QueueItemIndicator completed={completed} inProgress={inProgress} />
        <QueueItemContent completed={completed}>
          {inProgress && entry.activeForm ? entry.activeForm : entry.content}
        </QueueItemContent>
      </QueueItem>
    );
  };

  return (
    <Queue className={className}>
      {left.length > 0 && (
        <QueueSection>
          <QueueSectionTrigger>
            <QueueSectionLabel
              icon={<ListTodoIcon />}
              label={intl.formatMessage(
                { id: 'editor.todos.toDo', defaultMessage: '{count} to do' },
                { count: left.length },
              )}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList>{left.map(item)}</QueueList>
          </QueueSectionContent>
        </QueueSection>
      )}
      {done.length > 0 && (
        <QueueSection defaultOpen={left.length === 0 ? false : undefined}>
          <QueueSectionTrigger>
            <QueueSectionLabel
              icon={<ListChecksIcon />}
              label={intl.formatMessage(
                { id: 'editor.todos.completedCount', defaultMessage: '{count} completed' },
                { count: done.length },
              )}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList>{done.map(item)}</QueueList>
          </QueueSectionContent>
        </QueueSection>
      )}
    </Queue>
  );
}

export function TodoWriteRenderer({
  toolPart,
  messageId,
  partIndex,
}: TodoWriteRendererProps) {
  const state = normalizeToolState(toolPart.state);
  const toolName = getToolDisplayName(toolPart);
  const todos = extractTodosFromPart(toolPart);

  return (
    <Tool key={`${messageId}-${partIndex}`}>
      <ToolHeader icon={<ListTodoIcon />} type="dynamic-tool" toolName={toolName} state={state} />
      {todos.length > 0 && (
        <ToolContent>
          <TodoQueue todos={todos} />
        </ToolContent>
      )}
    </Tool>
  );
}
