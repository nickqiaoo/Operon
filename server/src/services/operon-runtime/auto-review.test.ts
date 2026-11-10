import type { AutoApprovalInput, AutoApprover, ChatModel } from 'operon-agents-core'
import { describe, expect, it, vi } from 'vitest'
import { withAutoReviewModel } from './auto-review.js'

const sessionModel = { id: 'session' } as unknown as ChatModel
const pickedModel = { id: 'picked' } as unknown as ChatModel
const input = { ctx: { model: sessionModel }, transcript: [], approvalRule: 'Bash' } as unknown as AutoApprovalInput

function setup(picked: string, resolve: (id: string) => Promise<ChatModel> = async () => pickedModel) {
  const judge: AutoApprover = { classify: vi.fn(async () => ({ decision: 'allow' as const })) }
  return { judge, wrapped: withAutoReviewModel(judge, () => picked, resolve) }
}

const judgedOn = (judge: AutoApprover) => vi.mocked(judge.classify).mock.calls[0]![0].ctx.model

describe('withAutoReviewModel', () => {
  it("judges on the session's model when none is picked", async () => {
    const { judge, wrapped } = setup('')
    await wrapped.classify(input)
    expect(judgedOn(judge)).toBe(sessionModel)
  })

  it('judges on the picked model and returns the verdict', async () => {
    const { judge, wrapped } = setup('vercel/steady')
    await expect(wrapped.classify(input)).resolves.toEqual({ decision: 'allow' })
    expect(judgedOn(judge)).toBe(pickedModel)
  })

  it("falls back to the session's model when the pick can't be resolved", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { judge, wrapped } = setup('gone/model', async () => { throw new Error('no such provider') })
    await wrapped.classify(input)
    expect(judgedOn(judge)).toBe(sessionModel)
    warn.mockRestore()
  })
})
