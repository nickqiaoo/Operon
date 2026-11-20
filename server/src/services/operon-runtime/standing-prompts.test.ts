import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai'
import { expect, it, vi } from 'vitest'
import type { AgentSession } from '@operon/agent-runtime'
import { withStandingAgentInstructions } from '../ai/agent-prompts.js'

vi.mock('./approved-extensions.js', () => ({
  loadApprovedExtensions: vi.fn(),
  syncApprovedExtensions: vi.fn(),
}))
vi.mock('./plugin-skill-sync.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./plugin-skill-sync.js')>(),
  syncPluginSkills: vi.fn(),
}))

it('sends the shared Operon instructions on create and restore without replacing the session persona', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'operon-standing-prompts-'))
  vi.stubEnv('OPERON_HOME', cwd)
  vi.stubEnv('OPERON_DATA_DIR', join(cwd, 'data'))
  try {
    const { getRuntime, getSessionManager } = await import('../ai/state.js')
    const { getOperonHarness } = await import('./index.js')
    const { modelManager } = await import('./resolve-model.js')
    const harness = await getOperonHarness()
    try {
      const runtime = getRuntime()
      const fixture = fauxProvider()
      modelManager.models.setProvider(fixture.provider)
      const params = { cwd, model: `${fixture.provider.id}/${fixture.getModel().id}`, mode: 'yolo' }
      const instructions = 'Session-specific persona for the test.'
      const prompts: string[] = []
      const capturePrompt = () => fixture.setResponses([(context) => {
        const system = context.messages.find((message) => message.role === 'system')
        const content = system?.content
        prompts.push(typeof content === 'string' ? content : content?.map((part) => part.text).join('') ?? '')
        return fauxAssistantMessage('OK', { stopReason: 'stop' })
      }])
      const run = async (session: AgentSession) => {
        capturePrompt()
        try {
          for await (const _part of session.send('Hello')) { /* drain the reply */ }
        } finally {
          await session.close()
        }
      }

      const session = await runtime.createSession('custom', { ...params, instructions })
      const resume = session.id!
      await run(session)
      await run(await runtime.createSession('custom', { ...params, resume }))

      const restored = await harness.resumeSession(resume)
      capturePrompt()
      await restored.prompt('Hello from a peer')
      await restored.close()

      await run(await getSessionManager().createStandaloneSession('custom', {
        ...params, instructions, operon: { standingPrompts: false },
      }))

      const shared = withStandingAgentInstructions(instructions)
      expect(prompts).toHaveLength(4)
      for (const prompt of prompts.slice(0, 3)) {
        expect(prompt.split(shared)).toHaveLength(2)
      }
      expect(prompts[3]).toContain(instructions)
      expect(prompts[3]).not.toContain('## File references')
    } finally {
      await harness.close()
    }
  } finally {
    vi.unstubAllEnvs()
    await rm(cwd, { recursive: true, force: true })
  }
})
