import { describe, expect, it } from 'vitest'
import { parseWorkflowMeta, coerceWorkflowOutput, sliceBalanced } from './workflow-tool-parse'

describe('sliceBalanced', () => {
  it('matches the outermost pair', () => {
    expect(sliceBalanced('x = {a:{b:1}} tail', 4, '{', '}')).toBe('{a:{b:1}}')
  })

  // The reason this is hand-rolled rather than a brace counter: a brace inside a
  // string literal must not close the block.
  it('ignores braces inside strings', () => {
    expect(sliceBalanced(`{ name: '}' }`, 0, '{', '}')).toBe(`{ name: '}' }`)
    expect(sliceBalanced('{ name: "}" }', 0, '{', '}')).toBe('{ name: "}" }')
    expect(sliceBalanced('{ name: `}` }', 0, '{', '}')).toBe('{ name: `}` }')
  })

  it('returns null when never closed', () => {
    expect(sliceBalanced('{ unterminated', 0, '{', '}')).toBeNull()
  })
})

describe('parseWorkflowMeta', () => {
  const script = [
    "export const meta = {",
    "  name: 'review',",
    "  description: 'Review areas in parallel',",
    "  phases: [",
    "    { title: 'Review', detail: 'Inspect each area' },",
    "    { title: 'Synthesize' },",
    "  ],",
    "}",
    "",
    "phase('Review')",
    "await agent('go', { agentType: 'codex' })",
  ].join('\n')

  it('reads name, description and phases', () => {
    const meta = parseWorkflowMeta(script)
    expect(meta.name).toBe('review')
    expect(meta.description).toBe('Review areas in parallel')
    expect(meta.phases).toEqual([
      { title: 'Review', detail: 'Inspect each area' },
      { title: 'Synthesize' },
    ])
  })

  // The card renders while the tool call is still streaming in, so a half-written
  // script must degrade to an empty skeleton rather than throw.
  it('degrades on a partial script', () => {
    expect(parseWorkflowMeta("export const meta = {\n  name: 'hal").phases).toEqual([])
    expect(parseWorkflowMeta('').phases).toEqual([])
    expect(parseWorkflowMeta('const notMeta = 1').phases).toEqual([])
  })

  it('does not mistake a later `phases` for the meta block', () => {
    const meta = parseWorkflowMeta(
      "export const meta = { name: 'x', phases: [{ title: 'A' }] }\nconst phases = [{ title: 'B' }]",
    )
    expect(meta.phases).toEqual([{ title: 'A' }])
  })
})

describe('coerceWorkflowOutput', () => {
  it('reads the launch ack', () => {
    expect(coerceWorkflowOutput({ status: 'async_launched', runId: 'wf-1', name: 'x' })).toMatchObject({
      status: 'async_launched',
      runId: 'wf-1',
    })
  })

  it('parses a JSON string result', () => {
    expect(coerceWorkflowOutput('{"runId":"wf-2"}')).toMatchObject({ runId: 'wf-2' })
  })

  // Tool results arrive wrapped differently depending on the provider.
  it('unwraps AI-SDK envelopes', () => {
    expect(coerceWorkflowOutput({ value: { runId: 'wf-3' } })).toMatchObject({ runId: 'wf-3' })
    expect(coerceWorkflowOutput({ output: { runId: 'wf-4' } })).toMatchObject({ runId: 'wf-4' })
  })

  it('returns undefined for anything with no recognizable field', () => {
    expect(coerceWorkflowOutput(undefined)).toBeUndefined()
    expect(coerceWorkflowOutput('not json')).toBeUndefined()
    expect(coerceWorkflowOutput({ unrelated: true })).toBeUndefined()
  })
})
