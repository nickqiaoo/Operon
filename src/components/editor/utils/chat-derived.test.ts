import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  buildTodosState,
  extractLatestTodosFromMessage,
} from './chat-derived'
import {
  extractTodosFromPart,
  isTodoWriteTool,
} from '../components/TodoWriteRenderer'
import type { ToolPartLike } from '../components/toolName'

type MessagePart = UIMessage['parts'][number]

const taskPart = ({
  id,
  name,
  input,
  output,
}: {
  id: string
  name: string
  input: Record<string, unknown>
  output?: unknown
}): MessagePart => ({
  type: `tool-${name}`,
  toolCallId: id,
  state: output === undefined ? 'input-available' : 'output-available',
  input,
  output,
} as unknown as MessagePart)

const assistantMessage = (id: string, parts: MessagePart[]): UIMessage => ({
  id,
  role: 'assistant',
  parts,
})

const isTaskPart = (part: MessagePart) => isTodoWriteTool(part as ToolPartLike)
const extractTaskTodos = (part: MessagePart) => extractTodosFromPart(part as ToolPartLike)

describe('chat-derived task aggregation', () => {
  it('keeps every TaskCreate from the same assistant message', () => {
    const message = assistantMessage('assistant-1', [
      taskPart({
        id: 'create-1',
        name: 'TaskCreate',
        input: { subject: 'Build the server', activeForm: 'Building the server' },
        output: 'Task #1 created successfully: Build the server',
      }),
      taskPart({
        id: 'create-2',
        name: 'TaskCreate',
        input: { subject: 'Build the client', activeForm: 'Building the client' },
        output: 'Task #2 created successfully: Build the client',
      }),
      taskPart({
        id: 'create-3',
        name: 'TaskCreate',
        input: { subject: 'Run typecheck', activeForm: 'Running typecheck' },
        output: 'Task #3 created successfully: Run typecheck',
      }),
    ])

    expect(extractLatestTodosFromMessage(message, isTaskPart, extractTaskTodos)).toEqual([
      { id: '1', content: 'Build the server', activeForm: 'Building the server', status: 'pending' },
      { id: '2', content: 'Build the client', activeForm: 'Building the client', status: 'pending' },
      { id: '3', content: 'Run typecheck', activeForm: 'Running typecheck', status: 'pending' },
    ])
  })

  it('applies TaskUpdate without replacing the other created tasks', () => {
    const created = assistantMessage('assistant-1', [
      taskPart({
        id: 'create-1',
        name: 'TaskCreate',
        input: { subject: 'Build the server' },
        output: 'Task #1 created successfully: Build the server',
      }),
      taskPart({
        id: 'create-2',
        name: 'TaskCreate',
        input: { subject: 'Build the client' },
        output: 'Task #2 created successfully: Build the client',
      }),
      taskPart({
        id: 'create-3',
        name: 'TaskCreate',
        input: { subject: 'Run typecheck' },
        output: 'Task #3 created successfully: Run typecheck',
      }),
    ])
    const updated = assistantMessage('assistant-2', [
      taskPart({
        id: 'update-2',
        name: 'TaskUpdate',
        input: { taskId: '2', status: 'in_progress', activeForm: 'Building the client' },
        output: 'Updated task #2 status',
      }),
    ])

    const result = buildTodosState([created, updated], 1, isTaskPart, extractTaskTodos)

    expect(result.todos).toHaveLength(3)
    expect(result.todos[1]).toEqual({
      id: '2',
      content: 'Build the client',
      activeForm: 'Building the client',
      status: 'in_progress',
    })
  })

  it('still treats TodoWrite as a full snapshot', () => {
    const created = assistantMessage('assistant-1', [
      taskPart({
        id: 'create-1',
        name: 'TaskCreate',
        input: { subject: 'Old task' },
        output: 'Task #1 created successfully: Old task',
      }),
    ])
    const snapshot = assistantMessage('assistant-2', [
      taskPart({
        id: 'todo-write',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Current task', status: 'in_progress' },
            { content: 'Next task', status: 'pending' },
          ],
        },
      }),
    ])

    const result = buildTodosState([created, snapshot], 1, isTaskPart, extractTaskTodos)

    expect(result.todos.map((todo) => todo.content)).toEqual(['Current task', 'Next task'])
  })

  it('merges Operon task status updates into the original tasks', () => {
    const created = assistantMessage('assistant-1', [
      taskPart({
        id: 'create-1',
        name: 'TaskCreate',
        input: { subject: 'Commit and verify the build' },
        output: 'Task #1 created: Commit and verify the build',
      }),
      taskPart({
        id: 'create-2',
        name: 'TaskCreate',
        input: { subject: 'Publish the package', activeForm: 'Publishing the package' },
        output: 'Task #2 created: Publish the package',
      }),
      taskPart({
        id: 'create-3',
        name: 'TaskCreate',
        input: { subject: 'Upgrade the app' },
        output: 'Task #3 created: Upgrade the app',
      }),
    ])
    const updated = assistantMessage('assistant-2', [
      taskPart({
        id: 'update-1',
        name: 'TaskUpdate',
        input: { taskId: '1', status: 'completed' },
        output: 'Task #1 updated: status',
      }),
      taskPart({
        id: 'update-2',
        name: 'TaskUpdate',
        input: { taskId: '2', status: 'in_progress' },
        output: 'Task #2 updated: status',
      }),
    ])

    const result = buildTodosState([created, updated], 1, isTaskPart, extractTaskTodos)

    expect(result.todos).toEqual([
      { id: '1', content: 'Commit and verify the build', activeForm: undefined, status: 'completed' },
      { id: '2', content: 'Publish the package', activeForm: 'Publishing the package', status: 'in_progress' },
      { id: '3', content: 'Upgrade the app', activeForm: undefined, status: 'pending' },
    ])
  })
})
