import { describe, expect, it } from 'vitest'
import {
  describeContextBlock,
  parseContextBlocks,
  stripContextBlocks,
  wrapContextBlock,
} from './context-blocks'

const selected = wrapContextBlock(
  'selected-text.md',
  'Selected from `study-notes/A1.md`:\n\n> agent-harness.ts\n> second line',
)

describe('context blocks', () => {
  it('round-trips a single block followed by the prompt', () => {
    const text = `${selected}\n\n这个里面实现的都是什么功能?`
    const parsed = parseContextBlocks(text)
    expect(parsed.blocks).toEqual([
      {
        filename: 'selected-text.md',
        content: 'Selected from `study-notes/A1.md`:\n\n> agent-harness.ts\n> second line',
      },
    ])
    expect(parsed.body).toBe('这个里面实现的都是什么功能?')
    expect(stripContextBlocks(text)).toBe('这个里面实现的都是什么功能?')
  })

  it('keeps blank-line paragraphs inside a block together', () => {
    const comment = wrapContextBlock('line-comment.md', 'Comment on `a.ts` (line 3):\n\n```diff\n+x\n```\n\nfix this')
    const parsed = parseContextBlocks(`${comment}\n\n${selected}\n\nplease`)
    expect(parsed.blocks.map((b) => b.filename)).toEqual(['line-comment.md', 'selected-text.md'])
    expect(parsed.blocks[0].content).toContain('```diff\n+x\n```\n\nfix this')
    expect(parsed.body).toBe('please')
  })

  it('handles a message that is only blocks', () => {
    const parsed = parseContextBlocks(selected)
    expect(parsed.blocks).toHaveLength(1)
    expect(parsed.body).toBe('')
  })

  it('leaves legacy text without a closing marker alone', () => {
    const legacy = '[File: selected-text.md]\nSelected text:\n\n> hi\n\nwhat is this'
    expect(parseContextBlocks(legacy)).toEqual({ blocks: [], body: legacy })
  })

  it('does not treat a [File:] marker in the middle of the prompt as a block', () => {
    const text = `look at this\n\n${selected}`
    expect(parseContextBlocks(text).blocks).toHaveLength(0)
  })

  it('describes selected text with and without a location', () => {
    const withPath = describeContextBlock(parseContextBlocks(selected).blocks[0])
    expect(withPath).toMatchObject({
      kind: 'selected-text',
      location: 'study-notes/A1.md',
      content: '> agent-harness.ts\n> second line',
      markdown: true,
    })
    const bare = describeContextBlock({ filename: 'selected-text.md', content: 'Selected text:\n\n> hi' })
    expect(bare).toMatchObject({ kind: 'selected-text', location: undefined, content: '> hi' })
  })

  it('describes line comments, annotations, pasted text and other files', () => {
    expect(
      describeContextBlock({ filename: 'line-comment.md', content: 'Comment on `a.ts` (line 3-4):\n\nnote' }),
    ).toMatchObject({ kind: 'line-comment', location: 'a.ts (line 3-4)', content: 'note' })
    expect(describeContextBlock({ filename: 'annotation.md', content: 'ctx' })).toMatchObject({
      kind: 'annotation',
      content: 'ctx',
    })
    expect(
      describeContextBlock({ filename: 'pasted_text_2026-09-02T00-00-00-000Z.txt', content: 'raw' }),
    ).toMatchObject({ kind: 'pasted-text', markdown: false })
    expect(describeContextBlock({ filename: 'notes.txt', content: 'x' })).toMatchObject({
      kind: 'file',
      location: 'notes.txt',
      markdown: false,
    })
  })
})
