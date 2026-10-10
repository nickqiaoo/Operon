import { describe, expect, it } from 'vitest'
import type { AssistantGrant } from '../../../../shared/assistant.js'
import type { StorageAdapter } from '../../storage/interface.js'
import { AssistantGrants, grantKeyForElicitation, grantKeyForTool } from './grants.js'

function setup() {
  const kv = new Map<string, unknown>()
  const storage = {
    get: <T>(key: string) => kv.get(key) as T | undefined,
    set: <T>(key: string, value: T) => void kv.set(key, value),
    delete: (key: string) => void kv.delete(key),
  } as unknown as StorageAdapter
  const published: AssistantGrant[][] = []
  let n = 0
  const grants = new AssistantGrants(storage, (g) => published.push(g), () => `g${++n}`, () => 1_000)
  return { grants, published }
}

const site = (origin: string) => ({ message: 'Open a site', meta: { connector_name: 'Browser Use', origin } })
const app = (name: string) => ({ message: 'Control an app', meta: { connector_id: 'computer-use', tool_params: { app: name } } })

describe('what an "Always allow" covers', () => {
  it('a site by its origin, an app by name, a capability by id', () => {
    expect(grantKeyForElicitation(site('https://x.com/home?a=1'))).toMatchObject({ kind: 'site', value: 'https://x.com', title: 'Open x.com', icon: 'globe' })
    expect(grantKeyForElicitation(app('Notes'))).toMatchObject({ kind: 'app', value: 'Notes', title: 'Control Notes' })
    expect(grantKeyForElicitation({ message: 'm', meta: { connector_id: 'computer-use', tool_params: { capability: 'clipboard' } } })).toMatchObject({
      kind: 'capability',
      value: 'clipboard',
    })
  })
  it('nothing for a file transfer, or a prompt that names nothing', () => {
    expect(grantKeyForElicitation({ message: 'm', meta: { file_transfer: true, origin: 'https://x.com' } })).toBeUndefined()
    expect(grantKeyForElicitation({ message: 'm' })).toBeUndefined()
  })
  it("a framework tool call by the rule the framework proposed", () => {
    expect(grantKeyForTool('Bash', 'Bash(git push:*)')).toMatchObject({ kind: 'tool', value: 'Bash(git push:*)', icon: 'terminal' })
    expect(grantKeyForTool('mcp__gmail__send', '')).toMatchObject({ value: 'mcp__gmail__send', icon: 'tool' })
  })
})

describe('AssistantGrants', () => {
  it('keeps one grant per thing, newest first, and publishes changes', () => {
    const { grants, published } = setup()
    grants.add(grantKeyForElicitation(site('https://x.com/a'))!)
    grants.add(grantKeyForElicitation(site('https://X.com/b'))!)
    grants.add(grantKeyForTool('Bash', 'Bash(ls:*)'))
    expect(grants.list().map((g) => g.value)).toEqual(['Bash(ls:*)', 'https://x.com'])
    expect(published).toHaveLength(2)
  })
  it('answers a prompt it covers, and stops once revoked', () => {
    const { grants } = setup()
    const g = grants.add(grantKeyForElicitation(app('Notes'))!)
    expect(grants.forElicitation(app('notes'))?.id).toBe(g.id)
    expect(grants.forElicitation(app('Mail'))).toBeUndefined()
    expect(grants.remove(g.id)).toBe(true)
    expect(grants.forElicitation(app('Notes'))).toBeUndefined()
    expect(grants.remove(g.id)).toBe(false)
  })
  it('turns tool grants into allow rules for new worker sessions', () => {
    const { grants } = setup()
    grants.add(grantKeyForTool('Bash', 'Bash(git push:*)'))
    grants.add(grantKeyForElicitation(site('https://x.com'))!)
    expect(grants.toolRules()).toEqual([{ decision: 'allow', scope: 'user', pattern: 'Bash(git push:*)', reason: 'Always allowed for the assistant' }])
  })
})
