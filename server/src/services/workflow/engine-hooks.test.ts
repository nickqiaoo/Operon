import { beforeEach, expect, it, vi } from 'vitest'
import { buildHooks } from './engine-hooks.js'
import { runProviderAgent } from './dispatch.js'
import { RunEventWriter } from './writer.js'
import { createWorktree, runWorkflow, WorkflowJournal } from 'operon-agents/advanced'
import { workflowJournalStore } from './journal-store.js'

vi.mock('./dispatch.js', () => ({ runProviderAgent: vi.fn(async () => 'done') }))
vi.mock('./store.js', () => ({ appendEvent: vi.fn() }))
vi.mock('../ai/state.js', () => ({ getChatStorage: () => undefined }))
const ssh = vi.hoisted(() => ({
  getcwd: () => '/remote/checkout',
  commands: { run: vi.fn() },
  files: { getInfo: vi.fn().mockResolvedValue({ kind: 'directory' }) },
  close: vi.fn(async () => {}),
}))
vi.mock('../ssh-environments.js', () => ({ sshProfile: vi.fn(), connectSshEnvironment: async () => ({ environment: ssh }) }))
vi.mock('operon-agents/advanced', async load => ({
  ...await load<typeof import('operon-agents/advanced')>(),
  createWorktree: vi.fn(async () => ({ cwd: '/remote/worktree', cleanup: vi.fn() })),
}))

beforeEach(() => vi.clearAllMocks())

it('isolates the Operon child on SSH and dispatches an external CLI to the host checkout', async () => {
  const sshEnvironment = { id: 'build', name: 'Build' }
  const local = { id: 'local', name: 'Local', cwd: '/host/checkout' }
  const controller = new AbortController()
  const hooks = buildHooks({ availableAgents: ['operon', 'codex'], sshEnvironment, additionalSshEnvironments: [local],
    cwd: '/remote/checkout', hostCwd: local.cwd }, new RunEventWriter('env-test'), controller)
  const step = { index: 0, label: 'worker', prompt: 'Review', onStart: vi.fn(), signal: controller.signal }
  await hooks.runAgent({ ...step, agentType: 'operon', isolation: 'worktree' })
  expect(vi.mocked(createWorktree).mock.calls[0]?.[0]).toBe(ssh)
  expect(runProviderAgent).toHaveBeenCalledWith(expect.objectContaining({
    providerId: 'custom', cwd: '/remote/worktree', sshEnvironment: { ...sshEnvironment, cwd: '/remote/worktree' }, additionalSshEnvironments: [local],
  }))
  expect(ssh.close).toHaveBeenCalledOnce()
  await hooks.runAgent({ ...step, agentType: 'codex' })
  const child = vi.mocked(runProviderAgent).mock.lastCall?.[0]
  expect(child).toMatchObject({ providerId: 'codex', cwd: local.cwd })
  expect(child?.sshEnvironment).toBeUndefined()
})

it('fails the workflow before dispatch if Git is missing on the SSH host', async () => {
  const framework = await vi.importActual<typeof import('operon-agents/advanced')>('operon-agents/advanced')
  vi.mocked(createWorktree).mockImplementationOnce(framework.createWorktree)
  ssh.commands.run.mockResolvedValueOnce({ exitCode: 127, stdout: '', stderr: 'git: command not found' })
  const writer = new RunEventWriter('missing-git')
  const hooks = buildHooks({ availableAgents: ['operon'], cwd: ssh.getcwd(),
    sshEnvironment: { id: 'build', name: 'Build' } }, writer, new AbortController())
  const journal = new WorkflowJournal(writer.runId, workflowJournalStore(writer.runId, { read: () => [], append: () => {} }))
  const outcome = await runWorkflow({ meta: { name: 'isolation', description: 'worktree required' },
    scriptBody: "return await agent('edit a file', { agentType: 'operon', isolation: 'worktree' })", args: undefined, journal, hooks })
  expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('git: command not found') })
  expect(runProviderAgent).not.toHaveBeenCalled()
  expect(ssh.close).toHaveBeenCalledOnce()
})
