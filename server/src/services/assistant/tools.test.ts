import { describe, expect, it, vi } from 'vitest'
import { bareToolName, isAssistantTool, stepLabel } from './labels.js'
import { callAssistantTool, toolsFor, type AssistantToolHost } from './tools.js'

function host(overrides: Partial<AssistantToolHost> = {}): AssistantToolHost {
  return {
    startTask: vi.fn(async () => 'w1'),
    continueTask: vi.fn(async () => 'delivered' as const),
    stopTask: vi.fn(async () => true),
    listTasks: () => [],
    progress: vi.fn(),
    finish: vi.fn(() => true),
    heartbeatDone: vi.fn(() => true),
    onFileWritten: vi.fn(),
    schedules: { list: () => [], create: vi.fn(), update: vi.fn(), remove: vi.fn(() => true) } as unknown as AssistantToolHost['schedules'],
    ...overrides,
  }
}

describe('the tools each kind of session is offered', () => {
  it('gives the main agent talking and dispatching; a worker only its hand-in tools; the wrap-up none (memory is files)', () => {
    expect(toolsFor('main').map((t) => t.name)).toEqual([
      'set_identity', 'memory_search', 'start_task', 'continue_task', 'stop_task', 'list_tasks',
      'schedule_list', 'schedule_create', 'schedule_update', 'schedule_delete',
    ])
    expect(toolsFor('worker').map((t) => t.name)).toEqual(['finish_task', 'heartbeat_done', 'report_progress'])
    expect(toolsFor('wrapup')).toEqual([])
  })
})

describe('callAssistantTool', () => {
  it("refuses a tool outside the caller's role, whatever a client listed", async () => {
    const h = host()
    const result = await callAssistantTool('start_task', { title: 't', prompt: 'p' }, { role: 'worker', id: 'w9' }, h)
    expect(result).toEqual({ text: 'start_task is not available here.', isError: true })
    expect(h.startTask).not.toHaveBeenCalled()
  })

  it('checks the arguments against the schema', async () => {
    const result = await callAssistantTool('finish_task', { title: 't', summary: 's', status: 'great' }, { role: 'worker', id: 'w1' }, host())
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/^Invalid arguments for finish_task/)
  })

  it("hands a worker's result in under the worker's own id", async () => {
    const h = host()
    const result = await callAssistantTool('finish_task', { title: 'Done it', summary: '42', status: 'done' }, { role: 'worker', id: 'w7' }, h)
    expect(result).toEqual({ text: 'Recorded. Stop now.' })
    expect(h.finish).toHaveBeenCalledWith('w7', { title: 'Done it', summary: '42', status: 'done' })
  })

  it('tells a heartbeat run that calls finish_task to use heartbeat_done', async () => {
    const result = await callAssistantTool('finish_task', { title: 't', summary: 's', status: 'done' }, { role: 'worker', id: 'h1' }, host({ finish: () => false }))
    expect(result).toEqual({ text: 'This run reports with heartbeat_done, not finish_task.', isError: true })
  })

  it('starts a task for the main agent and says which', async () => {
    const h = host()
    expect(await callAssistantTool('start_task', { title: 'Weather', prompt: 'Suzhou tomorrow' }, { role: 'main' }, h)).toEqual({ text: 'Started task w1.' })
    expect(h.startTask).toHaveBeenCalledWith({ title: 'Weather', prompt: 'Suzhou tomorrow' })
  })

  it('names an unknown tool', async () => {
    expect(await callAssistantTool('rm_rf', {}, { role: 'main' }, host())).toEqual({ text: 'Unknown tool: rm_rf', isError: true })
  })
})

describe('labels', () => {
  it("recognizes the assistant's own tools under every agent's naming", () => {
    expect(isAssistantTool('mcp__assistant__start_task')).toBe(true)
    expect(isAssistantTool('mcp__assistant_worker__finish_task')).toBe(true)
    expect(isAssistantTool('assistant_worker_report_progress')).toBe(true)
    expect(isAssistantTool('assistant_start_task')).toBe(true)
    expect(isAssistantTool('finish_task')).toBe(false)
    expect(isAssistantTool('mcp__other__finish_task')).toBe(false)
    expect(isAssistantTool('mcp__assistant__rm')).toBe(false)
  })

  it('strips the MCP server from a tool name', () => {
    expect(bareToolName('mcp__node_repl__js')).toBe('js')
    expect(bareToolName('mcp__github__list_issues')).toBe('list_issues')
    expect(bareToolName('Bash')).toBe('Bash')
  })

  it('reads a step name off the call: description, then command, then target', () => {
    expect(stepLabel('Bash', { command: 'ls -la', description: 'List files' })).toBe('List files')
    expect(stepLabel('exec', { command: ['bash', '-lc', 'echo hi'] })).toBe('echo hi')
    // Codex quotes by concatenation, so the outer quotes need not match.
    expect(stepLabel('exec', { command: `/bin/zsh -lc "find . -name '*.txt' | while read f; do echo "'$f'; done'` })).toBe(`find . -name '*.txt' | while read f; do echo "'$f'; done`)
    expect(stepLabel('exec', { command: '/bin/zsh -lc "curl -s https://example.com"' })).toBe('curl -s https://example.com')
    expect(stepLabel('Read', { file_path: '/home/a/ws/notes.md' }, '/home/a/ws')).toBe('Read: notes.md')
    expect(stepLabel('WebFetch', { url: 'https://example.com' })).toBe('WebFetch: https://example.com')
    expect(stepLabel('mcp__node_repl__js', { code: 'x' })).toBe('js')
    expect(stepLabel('Bash', '{"command":"pwd"}')).toBe('pwd')
  })
})
