import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/api', () => ({ api: {} }))
import { dedupeByPrefix, type SlashCommandItem } from './useModelManagement'

describe('slash menu names', () => {
  it('preserves independently executable MCP commands while grouping plugin skills', () => {
    const items: SlashCommandItem[] = [
      { name: 'docs:search', type: 'command', description: '' },
      { name: 'docs:read', type: 'command', description: '' },
      { name: 'docs:search', type: 'command', description: '' },
      { name: 'review:code', type: 'skill', description: '' },
      { name: 'review:tests', type: 'skill', description: '' },
    ]
    expect(dedupeByPrefix(items).map((item) => item.name)).toEqual(['docs:search', 'docs:read', 'review'])
  })
})
