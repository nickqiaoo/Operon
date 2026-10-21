import { describe, expect, it } from 'vitest'
import { parseJsonReply, splitTrailingJson, summarizeStructured } from './json-reply'

describe('parseJsonReply', () => {
  it('reads bare and fenced JSON', () => {
    expect(parseJsonReply(' {"a":1} ')).toEqual({ a: 1 })
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJsonReply('Here it is:\n```\n[1,2]\n```\nDone.')).toEqual([1, 2])
  })

  // What a Codex lead actually returned: its plan, then the object.
  it('skips a sentence before the value', () => {
    const reply = '我会只核对当前 checkout 中的 404 源码，不作任何改动。{"verdict":"converged","design":"## Intent\\n{not json}"}'
    expect(parseJsonReply(reply)).toEqual({ verdict: 'converged', design: '## Intent\n{not json}' })
  })

  it('skips a bracket in the lead-in that is not the value', () => {
    expect(parseJsonReply('Checked {two} files. {"ok":true}')).toEqual({ ok: true })
  })

  it('returns undefined when there is no JSON at all', () => {
    expect(parseJsonReply('I could not do it.')).toBeUndefined()
    expect(parseJsonReply('{ broken')).toBeUndefined()
  })
})

describe('splitTrailingJson', () => {
  it('splits narration from the object it ends with', () => {
    expect(splitTrailingJson('Checked {two} files. {"ok":true}')).toEqual({ lead: 'Checked {two} files.', value: { ok: true } })
    expect(splitTrailingJson('Done:\n```json\n{"a":[1]}\n```')).toEqual({ lead: 'Done:', value: { a: [1] } })
  })

  it('leaves prose and bare scalars alone', () => {
    expect(splitTrailingJson('Use `{a}` here.')).toBeNull()
    expect(splitTrailingJson('{"a":1} and then more prose')).toBeNull()
    expect(splitTrailingJson('42')).toBeNull()
  })
})

describe('summarizeStructured', () => {
  it('puts short fields first, then lists as counts, and skips long text', () => {
    expect(
      summarizeStructured({ verdict: 'pass', issues: [{}, {}], rulings: [], designBroken: '', note: 'x'.repeat(200) }),
    ).toBe('verdict: pass · 2 issues · 0 rulings')
  })

  it('falls back to the first long text when there is nothing short', () => {
    expect(summarizeStructured({ design: '## Intent\nShip it' })).toBe('## Intent Ship it')
  })
})
