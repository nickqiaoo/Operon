import { describe, expect, it } from 'vitest'
import { answersFor, renderPending } from './answers.js'
import type { SurfacePending } from '../../types/task.js'

const approval: SurfacePending = {
  approvalId: 'a1',
  taskId: 1,
  chatId: 10,
  surfaceKind: 'linear_session',
  surfaceRef: 'sess',
  toolName: 'Bash',
  input: { command: 'rm -rf dist' },
  createdAt: 0,
}

const question: SurfacePending = {
  approvalId: 'q1',
  taskId: 1,
  chatId: 10,
  surfaceKind: 'github_pr',
  surfaceRef: 'acme/app#1',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      { question: 'Which database?', header: 'Storage', options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'embedded' }] },
    ],
  },
  createdAt: 0,
}

describe('renderPending', () => {
  it('renders an approval with the command and the approve/reject footer', () => {
    const text = renderPending([approval])
    expect(text).toContain('**Approval needed:** `Bash`')
    expect(text).toContain('rm -rf dist')
    expect(text).toContain('Reply `approve` or `reject`')
  })

  it('renders questions with options and a free-text footer', () => {
    const text = renderPending([question])
    expect(text).toContain('**Question 1 (Storage):** Which database?')
    expect(text).toContain('- **SQLite** — embedded')
    expect(text).toContain('Free text is fine')
  })
})

describe('answersFor', () => {
  it('reads approval off the first word and passes the rest as reason on reject', () => {
    const [ok] = answersFor([approval], 'approve, go ahead')
    expect(ok?.outcome).toEqual({ outcome: 'allow' })
    const [no] = answersFor([approval], 'nope, keep dist')
    expect(no?.outcome).toEqual({ outcome: 'deny', reason: 'keep dist' })
  })

  it('treats an unclear reply as a rejection rather than guessing approval', () => {
    const [r] = answersFor([approval], 'hmm what does that do')
    expect(r?.outcome).toMatchObject({ outcome: 'deny' })
  })

  it('answers every question with the whole reply, keyed by question text', () => {
    const [r] = answersFor([question], 'SQLite, we ship a single binary')
    expect(r?.approvalId).toBe('q1')
    expect(r?.chatId).toBe(10)
    expect(r?.outcome).toEqual({
      outcome: 'allow',
      updatedInput: {
        questions: question.input.questions,
        answers: { 'Which database?': 'SQLite, we ship a single binary' },
        method: 'freeform',
      },
    })
  })

  it('supports Chinese approvals', () => {
    expect(answersFor([approval], '同意')[0]?.outcome).toEqual({ outcome: 'allow' })
    expect(answersFor([approval], '不要，先别删')[0]?.outcome).toMatchObject({ outcome: 'deny' })
  })
})
