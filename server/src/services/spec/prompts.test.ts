import { describe, expect, it } from 'vitest'
import { branchReviewPrompt, builderFoundNothing, signoffNext, synthesisPrompt, ticketReviewPrompt, triagePrompt } from './prompts.js'
import { crossFamilyReviewed } from './review-run.js'

describe('builderFoundNothing', () => {
  it('accepts the bare sentinel and a reply that ends with it', () => {
    expect(builderFoundNothing('nothing important left')).toBe(true)
    expect(builderFoundNothing('Nothing important left.\n')).toBe(true)
    expect(builderFoundNothing('我会核对 404 页面和主题变量，只列出会改变规划的问题。nothing important left')).toBe(true)
    expect(builderFoundNothing('“nothing important left”。')).toBe(true)
  })

  it('rejects a reply that asks questions', () => {
    expect(builderFoundNothing('1. Which table owns the run state?\nWhy: it decides the migration.')).toBe(false)
    expect(builderFoundNothing('nothing important left, except: 1. who owns the cache?')).toBe(false)
  })
})

describe('decisions since the brief', () => {
  const answers = '## Direction\n1. A or B?\n\n### Answers\nB.'

  it('reaches triage, so it cannot reopen an answered choice', () => {
    const prompt = triagePrompt('## Open\n- A or B is still open', answers, '## Intent', '1. A or B?')
    expect(prompt).toContain('## Decisions the user made since the brief')
    expect(prompt).toContain('### Answers\nB.')
    expect(triagePrompt('brief', null, 'design', 'q')).not.toContain('## Decisions the user made')
  })

  it('reaches synthesis', () => {
    const prompt = synthesisPrompt({
      brief: 'brief',
      grounding: 'g',
      criteria: ['c'],
      candidates: [],
      judge: 'j',
      feedback: null,
      answers,
    })
    expect(prompt).toContain('### Answers\nB.')
  })
})

describe('a spec limited to one agent', () => {
  const ticket = { key: 'T1', title: 't', delivers: 'd', acceptance: ['a'], blockedBy: [], interfaces: [] }

  it('never claims another model family reviewed or built it', () => {
    const build = [{ implementer: 'codex', reviewer: 'codex' }]
    expect(crossFamilyReviewed(build)).toBe(false)
    expect(signoffNext(1, crossFamilyReviewed(build))).not.toMatch(/another model family/)
    expect(ticketReviewPrompt({ design: '', ticket, report: null, diff: '', stat: '', crossFamily: false })).not.toMatch(/another model family/)
    expect(
      branchReviewPrompt({ brief: '', design: '', tickets: [ticket], rulings: [], diff: '', stat: '', base: 'main', peerReviewer: false }),
    ).not.toMatch(/another model family/)
  })

  it('says so when the families did differ', () => {
    const build = [{ implementer: 'codex', reviewer: 'claude-code' }]
    expect(signoffNext(1, crossFamilyReviewed(build))).toMatch(/another model family/)
  })
})
