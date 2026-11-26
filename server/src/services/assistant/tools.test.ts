import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityStatus, ActivitySummary } from '../../../../shared/assistant.js'
import { bareToolName, isAssistantTool, stepLabel } from './labels.js'
import { callAssistantTool, toolsFor, type AssistantToolHost, type TaskPage, type TaskQuery } from './tools.js'

function host(overrides: Partial<AssistantToolHost> = {}): AssistantToolHost {
  return {
    startTask: vi.fn(async () => 'w1'),
    continueTask: vi.fn(async () => 'delivered' as const),
    stopTask: vi.fn(async () => true),
    listTasks: () => ({ items: [], total: 0 }),
    progress: vi.fn(),
    finish: vi.fn(() => true),
    heartbeatDone: vi.fn(() => true),
    onFileWritten: vi.fn(),
    schedules: { list: () => [], create: vi.fn(), update: vi.fn(), remove: vi.fn(() => true) } as unknown as AssistantToolHost['schedules'],
    operon: { workspaceList: () => '', workspaceOverview: async () => '', runningList: () => '', waitingList: () => '' },
    actions: {
      addProject: vi.fn(async () => 'Added'),
      githubPrs: vi.fn(async () => ''),
      githubPr: vi.fn(async () => ''),
      githubPrCreate: vi.fn(async () => ''),
      createWorkspace: vi.fn(async () => 'Created'),
      boardList: vi.fn(() => ''),
      boardGet: vi.fn(async () => ''),
      boardCreate: vi.fn(() => ''),
      boardUpdate: vi.fn(async () => ''),
      boardComment: vi.fn(() => ''),
      boardAgents: vi.fn(() => ''),
      boardDispatch: vi.fn(async () => 'Dispatched'),
    },
    specs: {
      start: vi.fn(async () => 'Started'),
      answer: vi.fn(async () => 'Saved'),
      status: vi.fn(async () => 'designing'),
      switchAgent: vi.fn(async () => 'Switched'),
      declineSwitch: vi.fn(async () => 'Declined'),
      messageCoordinator: vi.fn(async () => 'Passed'),
    },
    coding: { models: vi.fn(async () => '[]'), start: vi.fn(async () => 'Started'), send: vi.fn(async () => 'Sent'), status: vi.fn(() => '{}'), stop: vi.fn(() => 'Stopped') },
    ...overrides,
  }
}

describe('the tools each kind of session is offered', () => {
  it('gives the main agent talking and dispatching; a worker only its hand-in tools; the wrap-up none (memory is files)', () => {
    expect(toolsFor('main').map((t) => t.name)).toEqual([
      'identity_set', 'memory_search', 'helper_start', 'helper_continue', 'helper_stop', 'helper_list',
      'workspace_list', 'workspace_inspect', 'conversation_list_running', 'conversation_list_waiting',
      'workspace_create', 'project_add', 'github_pr_list', 'github_pr_get', 'github_pr_create', 'board_list', 'board_get', 'board_create', 'board_update', 'board_comment', 'board_list_agents', 'board_dispatch',
      'coding_list_agents', 'coding_start', 'coding_send', 'coding_get_status', 'coding_stop',
      'spec_start', 'spec_answer_questions', 'spec_get_status', 'spec_switch_agent', 'spec_decline_switch', 'spec_message_coordinator',
      'schedule_list', 'schedule_create', 'schedule_update', 'schedule_delete',
    ])
    expect(toolsFor('worker').map((t) => t.name)).toEqual(['helper_finish', 'helper_report_progress'])
    expect(toolsFor('heartbeat').map((t) => t.name)).toEqual(['heartbeat_finish'])
    expect(toolsFor('wrapup')).toEqual([])
  })
})

describe('the board and specs from the assistant', () => {
  const main = { role: 'main', id: 'm' } as const

  it("won't start a spec until the user has chosen who leads it", async () => {
    const h = host()
    const args = { project_id: 5, title: 'T', brief: 'B', agent: 'codex', model: 'default', selection_confirmed: false }
    expect((await callAssistantTool('spec_start', args, main, h)).isError).toBe(true)
    expect(h.specs.start).not.toHaveBeenCalled()

    await callAssistantTool('spec_start', { ...args, selection_confirmed: true }, main, h)
    expect(h.specs.start).toHaveBeenCalledWith({ projectId: 5, title: 'T', brief: 'B', providerId: 'codex', model: 'default' })
  })

  it('reports a refused dispatch to the model', async () => {
    const h = host()
    vi.mocked(h.actions.boardDispatch).mockRejectedValue(new Error('There is no agent @x.'))
    expect(await callAssistantTool('board_dispatch', { project_id: 5, task: 7, assignee: 'x' }, main, h)).toEqual({ text: 'There is no agent @x.', isError: true })
  })
})

describe('callAssistantTool', () => {
  it("refuses a tool outside the caller's role, whatever a client listed", async () => {
    const h = host()
    const result = await callAssistantTool('helper_start', { title: 't', prompt: 'p' }, { role: 'worker', id: 'w9' }, h)
    expect(result).toEqual({ text: 'helper_start is not available here.', isError: true })
    expect(h.startTask).not.toHaveBeenCalled()
  })

  it('checks the arguments against the schema', async () => {
    const result = await callAssistantTool('helper_finish', { title: 't', summary: 's', status: 'great' }, { role: 'worker', id: 'w1' }, host())
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/^Invalid arguments for helper_finish/)
  })

  it("hands a worker's result in under the worker's own id", async () => {
    const h = host()
    const result = await callAssistantTool('helper_finish', { title: 'Done it', summary: '42', status: 'done' }, { role: 'worker', id: 'w7' }, h)
    expect(result).toEqual({ text: 'Recorded. Stop now.' })
    expect(h.finish).toHaveBeenCalledWith('w7', { title: 'Done it', summary: '42', status: 'done' })
  })

  it('offers a heartbeat run only its own way of reporting', async () => {
    const result = await callAssistantTool('helper_finish', { title: 't', summary: 's', status: 'done' }, { role: 'heartbeat', id: 'h1' }, host())
    expect(result).toEqual({ text: 'helper_finish is not available here.', isError: true })
  })

  it('starts a task for the main agent and says which', async () => {
    const h = host()
    expect(await callAssistantTool('helper_start', { title: 'Weather', prompt: 'Suzhou tomorrow' }, { role: 'main' }, h)).toEqual({ text: 'Started task w1.' })
    expect(h.startTask).toHaveBeenCalledWith({ title: 'Weather', prompt: 'Suzhou tomorrow' })
  })

  it('names an unknown tool', async () => {
    expect(await callAssistantTool('rm_rf', {}, { role: 'main' }, host())).toEqual({ text: 'Unknown tool: rm_rf', isError: true })
  })
})

describe('helper_list', () => {
  const main = { role: 'main', id: 'm' } as const
  const NOW = 1_000_000_000
  const task = (id: string, status: ActivityStatus, extra: Partial<ActivitySummary> = {}): ActivitySummary => ({
    id, taskId: `agent-${id}`, title: `T${id}`, summary: `s${id}`, status, startedAt: NOW - 5 * 60_000, ...extra,
  })
  // 3 running or waiting, 25 finished, newest first.
  const all: ActivitySummary[] = [
    task('r1', 'running', { agent: 'coding', coding: { chatId: 42, workspaceId: 3, workspaceName: 'login', projectName: 'web', providerId: 'codex', model: 'gpt-5' } }),
    task('r2', 'waiting'),
    task('r3', 'running', { source: 'schedule' }),
    ...Array.from({ length: 25 }, (_, i) => task(`d${i + 1}`, 'done', { finishedAt: NOW - 2 * 3_600_000 })),
  ]
  const listTasks = vi.fn((q: TaskQuery): TaskPage => {
    const matching = all.filter((t) => (!q.statuses || q.statuses.includes(t.status)) && (!q.kind || (q.kind === 'coding') === Boolean(t.coding)))
    return { items: matching.slice(q.offset, q.offset + q.limit), total: matching.length }
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    listTasks.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('shows every active task, then a page of finished ones, saying how to see more', async () => {
    const { text } = await callAssistantTool('helper_list', {}, main, host({ listTasks }))
    const [active, finished] = text.split('\n\n')
    expect(active).toBe([
      'Running or waiting, most recent first (3):',
      '- r1 · running · Tr1 — sr1 · coding agent codex / gpt-5 · chat 42 · workspace "login" in project "web" · started 5m ago',
      '- r2 · waiting · Tr2 — sr2 · started 5m ago',
      '- r3 · running · Tr3 — sr3 · from a schedule · started 5m ago',
    ].join('\n'))
    expect(finished.split('\n')[0]).toBe('Finished, most recent first (1–10 of 25; offset 10 for the next):')
    expect(finished.split('\n')).toHaveLength(11)
    expect(finished).toContain('- d1 · done · Td1 — sd1 · finished 2h ago')
  })

  it('pages through one status with offset and limit', async () => {
    const h = host({ listTasks })
    expect((await callAssistantTool('helper_list', { status: 'finished', offset: 20 }, main, h)).text.split('\n')[0])
      .toBe('Finished, most recent first (21–25 of 25):')
    expect((await callAssistantTool('helper_list', { status: 'finished', offset: 30 }, main, h)).text).toBe('No more: there are 25.')
    expect((await callAssistantTool('helper_list', { status: 'all', limit: 2 }, main, h)).text.split('\n')[0])
      .toBe('All tasks, most recent first (1–2 of 28; offset 2 for the next):')
    expect(listTasks).toHaveBeenLastCalledWith({ offset: 0, limit: 2 })
  })

  it('narrows to coding agents and rejects a page past the cap', async () => {
    const h = host({ listTasks })
    const { text } = await callAssistantTool('helper_list', { status: 'active', kind: 'coding' }, main, h)
    expect(text.split('\n')).toHaveLength(2)
    expect(listTasks).toHaveBeenLastCalledWith({ statuses: ['running', 'waiting'], kind: 'coding', offset: 0, limit: 20 })
    expect((await callAssistantTool('helper_list', { limit: 500 }, main, h)).isError).toBe(true)
  })

  it('says so when there is nothing at all', async () => {
    expect((await callAssistantTool('helper_list', {}, main, host())).text).toBe('No tasks yet.')
  })
})

describe('labels', () => {
  it("recognizes the assistant's own tools under every agent's naming", () => {
    expect(isAssistantTool('mcp__assistant__helper_start')).toBe(true)
    expect(isAssistantTool('mcp__assistant_worker__helper_finish')).toBe(true)
    expect(isAssistantTool('assistant_worker_helper_report_progress')).toBe(true)
    expect(isAssistantTool('assistant_helper_start')).toBe(true)
    // Operon's own runtime runs them in process, under their own names.
    expect(isAssistantTool('helper_finish')).toBe(true)
    expect(isAssistantTool('Bash')).toBe(false)
    expect(isAssistantTool('mcp__other__helper_finish')).toBe(false)
    expect(isAssistantTool('mcp__assistant__rm')).toBe(false)
  })

  it('strips the MCP server from a tool name', () => {
    expect(bareToolName('mcp__operonrepl__js')).toBe('js')
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
    expect(stepLabel('mcp__operonrepl__js', { code: 'x' })).toBe('js')
    expect(stepLabel('Bash', '{"command":"pwd"}')).toBe('pwd')
  })
})
