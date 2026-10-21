import { describe, expect, it } from 'vitest'
import { parseJsonReply } from './json-reply.js'

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
