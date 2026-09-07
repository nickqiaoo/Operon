import { describe, it, expect } from 'vitest'
import { buildScope, evaluateCondition, parseOutputValue, renderTemplate } from './template.js'
import type { CanvasNode } from '../../types/canvas-workflow.js'

const node = (id: string, name: string): CanvasNode => ({
  id, name, type: 'input', position: { x: 0, y: 0 }, data: { prompt: '' },
})

describe('parseOutputValue', () => {
  it('turns JSON objects and arrays into data', () => {
    expect(parseOutputValue('{"passed": true, "n": 2}')).toEqual({ passed: true, n: 2 })
    expect(parseOutputValue(' [1, 2] ')).toEqual([1, 2])
  })

  it('keeps scalars and broken JSON as the original string', () => {
    expect(parseOutputValue('123')).toBe('123')
    expect(parseOutputValue('true')).toBe('true')
    expect(parseOutputValue('{not json')).toBe('{not json')
  })

  it('renders a whole object as JSON instead of [object Object]', () => {
    const scope = { review: parseOutputValue('{"a": {"b": 1}}') }
    expect(renderTemplate('{{ review }} / {{ review.a }}', scope)).toBe('{"a":{"b":1}} / {"b":1}')
    expect(JSON.stringify(scope.review)).toBe('{"a":{"b":1}}')
  })
})

describe('buildScope', () => {
  it('publishes every completed node by name, sanitizing odd names', () => {
    const outputs = new Map([['n1', 'alpha'], ['n2', '{"ok": true}']])
    const scope = buildScope(undefined, outputs, [node('n1', 'first step'), node('n2', 'review')])
    expect(scope.first_step).toBe('alpha')
    expect(scope.review).toEqual({ ok: true })
    expect(scope.env).toEqual({})
  })

  it('layers graph outputs over the inherited scope', () => {
    const scope = buildScope({ item: 'x', review: 'outer' }, new Map([['n2', 'inner']]), [node('n2', 'review')])
    expect(scope.item).toBe('x')
    expect(scope.review).toBe('inner')
  })
})

describe('renderTemplate filters', () => {
  it('tojson and lines', () => {
    expect(renderTemplate('{{ v | tojson }}', { v: { a: 1 } })).toBe('{"a":1}')
    expect(renderTemplate('{{ (v | lines) | length }}', { v: 'a\n\nb\n c ' })).toBe('3')
  })
})

describe('evaluateCondition', () => {
  it('evaluates bare expressions against the scope', () => {
    expect(evaluateCondition('review.passed', { review: { passed: true } })).toBe(true)
    expect(evaluateCondition('review.passed and count > 1', { review: { passed: true }, count: 1 })).toBe(false)
    expect(evaluateCondition('"FAIL" in output', { output: 'tests FAIL' })).toBe(true)
  })

  it('treats a missing variable as false and an empty expression as an error', () => {
    expect(evaluateCondition('missing.field', {})).toBe(false)
    expect(() => evaluateCondition('   ', {})).toThrow()
  })
})
