import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxProvider, getCurrentTools } from '@earendil-works/pi-ai'
import { expect, it, vi } from 'vitest'
import type { AgentSession } from '@operon/agent-runtime'
import { initWebTools, saveWebToolSettings } from '../web-tools.js'

vi.mock('./approved-extensions.js', () => ({ loadApprovedExtensions: vi.fn(), syncApprovedExtensions: vi.fn() }))
vi.mock('./plugin-skill-sync.js', async (load) => ({ ...await load<typeof import('./plugin-skill-sync.js')>(), syncPluginSkills: vi.fn() }))

it('offers the selected web tools at session open and re-reads the selection on restore', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'operon-web-session-'))
  vi.stubEnv('OPERON_HOME', cwd)
  vi.stubEnv('OPERON_DATA_DIR', join(cwd, 'data'))
  const values = new Map<string, unknown>()
  initWebTools({
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key, value) => { values.set(key, value) },
    delete: vi.fn(), keys: () => [], getAll: () => undefined, setAll: vi.fn(),
  })
  try {
    const { getRuntime } = await import('../ai/state.js')
    const { getOperonHarness } = await import('./index.js')
    const { modelManager } = await import('./resolve-model.js')
    const harness = await getOperonHarness()
    try {
      const fixture = fauxProvider()
      modelManager.models.setProvider(fixture.provider)
      const params = { cwd, model: `${fixture.provider.id}/${fixture.getModel().id}`, mode: 'yolo' }
      const open = (resume?: string) => getRuntime().createSession('custom', { ...params, resume })
      async function offered(session: AgentSession) {
        let names: string[] | undefined
        fixture.setResponses([context => {
          names = getCurrentTools(context.messages).map(tool => tool.name).filter(name => name === 'WebFetch' || name === 'WebSearch').sort()
          return fauxAssistantMessage('OK', { stopReason: 'stop' })
        }])
        for await (const _part of session.send('Check the tool list')) { /* drain */ }
        return names
      }
      const original = await open()
      expect(await offered(original)).toEqual([])
      saveWebToolSettings({ search: 'deepseek', fetch: 'off', keys: { deepseek: 'fixture' } })
      const searching = await open()
      expect(await offered(searching)).toEqual(['WebSearch'])
      expect(await offered(original)).toEqual([])
      saveWebToolSettings({ search: 'off', fetch: 'deepseek', keys: {} })
      const reading = await open()
      expect(await offered(reading)).toEqual(['WebFetch'])
      expect(await offered(searching)).toEqual(['WebSearch'])
      saveWebToolSettings({ search: 'deepseek', fetch: 'deepseek', keys: {} })
      const id = original.id!
      await original.close()
      const restored = await open(id)
      expect(await offered(restored)).toEqual(['WebFetch', 'WebSearch'])
      await Promise.all([restored.close(), reading.close(), searching.close()])
    } finally {
      await harness.close()
    }
  } finally {
    vi.unstubAllEnvs()
    await rm(cwd, { recursive: true, force: true })
  }
})
