import { describe, it, expect } from 'vitest'
import { compileConditionGroup, compileConditionRow } from './conditions.js'
import { checkTemplateSyntax, evaluateCondition } from './template.js'
import { validateTemplates } from './validate.js'
import type { CanvasNode } from '../../types/canvas-workflow.js'

const scope = {
  review: { passed: true, issues: ['a', 'b'], score: 7.5 },
  tests: 'ran 12 tests, 1 FAIL',
  empty: '',
  count: '3',
}

const ev = (row: Parameters<typeof compileConditionRow>[0]) => evaluateCondition(compileConditionRow(row), scope)

describe('compileConditionRow', () => {
  it('handles unary operators', () => {
    expect(ev({ variable: 'review.passed', operator: 'is_true' })).toBe(true)
    expect(ev({ variable: 'review.passed', operator: 'is_false' })).toBe(false)
    expect(ev({ variable: 'empty', operator: 'is_empty' })).toBe(true)
    expect(ev({ variable: 'tests', operator: 'not_empty' })).toBe(true)
    expect(ev({ variable: 'missing.deep', operator: 'is_empty' })).toBe(true)
  })

  it('compares strings and numbers sensibly', () => {
    expect(ev({ variable: 'count', operator: 'equals', value: '3' })).toBe(true)
    expect(ev({ variable: 'review.score', operator: 'gt', value: '7' })).toBe(true)
    expect(ev({ variable: 'count', operator: 'lte', value: '2' })).toBe(false)
    expect(ev({ variable: 'tests', operator: 'not_equals', value: 'x' })).toBe(true)
  })

  it('contains works on strings and arrays, matches uses a regex', () => {
    expect(ev({ variable: 'tests', operator: 'contains', value: 'FAIL' })).toBe(true)
    expect(ev({ variable: 'review.issues', operator: 'contains', value: 'b' })).toBe(true)
    expect(ev({ variable: 'review.issues', operator: 'not_contains', value: 'z' })).toBe(true)
    expect(ev({ variable: 'tests', operator: 'matches', value: '\\d+ FAIL' })).toBe(true)
  })

  it('rejects a variable that is not a path', () => {
    expect(() => compileConditionRow({ variable: 'a b', operator: 'is_true' })).toThrow('invalid variable')
  })
})

describe('compileConditionGroup', () => {
  it('joins rows and lets a written expression win', () => {
    const rows = [
      { variable: 'review.passed', operator: 'is_true' as const },
      { variable: 'tests', operator: 'contains' as const, value: 'FAIL' },
    ]
    expect(evaluateCondition(compileConditionGroup({ conditions: rows, combinator: 'and' }), scope)).toBe(true)
    expect(evaluateCondition(compileConditionGroup({ conditions: [rows[0], { variable: 'empty', operator: 'not_empty' }], combinator: 'and' }), scope)).toBe(false)
    expect(evaluateCondition(compileConditionGroup({ conditions: [rows[0], { variable: 'empty', operator: 'not_empty' }], combinator: 'or' }), scope)).toBe(true)
    expect(compileConditionGroup({ conditions: rows, expression: 'count == "3"' })).toBe('count == "3"')
    expect(compileConditionGroup({})).toBe('false')
  })
})

describe('validateTemplates', () => {
  const pos = { x: 0, y: 0 }
  it('accepts good templates and names the field of a broken one', () => {
    const good: CanvasNode = { id: 't', type: 'template', name: 'fmt', position: pos, data: { template: '{{ review.score | round }} {% if x %}y{% endif %}' } }
    expect(validateTemplates([good])).toBeNull()

    const bad: CanvasNode = { id: 'h', type: 'http', name: 'call', position: pos, data: { method: 'GET', url: 'https://x/{{ id', headers: [], bodyType: 'none', body: '', auth: { type: 'none' } } }
    const error = validateTemplates([bad])
    expect(error).toContain('Node "call" url')

    const badIf: CanvasNode = { id: 'i', type: 'if', name: 'gate', position: pos, data: { cases: [{ id: 'c1', expression: 'review.passed and (' }] } }
    expect(validateTemplates([badIf])).toContain('case c1')

    const badRow: CanvasNode = { id: 'i2', type: 'if', name: 'gate2', position: pos, data: { cases: [{ id: 'c1', conditions: [{ variable: 'not a path', operator: 'is_true' }] }] } }
    expect(validateTemplates([badRow])).toContain('invalid variable')
  })

  it('reports nunjucks syntax errors briefly', () => {
    expect(checkTemplateSyntax('{{ a')).toBeTruthy()
    expect(checkTemplateSyntax('{{ a }}')).toBeNull()
    expect(checkTemplateSyntax('a and (', 'condition')).toBeTruthy()
  })
})
