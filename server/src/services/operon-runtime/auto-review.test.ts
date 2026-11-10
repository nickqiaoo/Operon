import type { AutoApprovalInput, AutoApprover, ChatModel } from 'operon-agents'
import { describe, expect, it, vi } from 'vitest'
import { withAutoReviewModel } from './auto-review.js'

const sessionModel = { id: 'session' } as unknown as ChatModel
const pickedModel = { id: 'picked' } as unknown as ChatModel
const input = { ctx: { model: sessionModel }, transcript: [], approvalRule: 'Bash' } as unknown as AutoApprovalInput

function setup(picked: string, resolve: (id: string) => Promise<ChatModel> = async () => pickedModel) {
  const sessionJudge: AutoApprover = { classify: vi.fn(async () => ({ decision: 'allow' as const })) }
  const pickedJudge: AutoApprover = { classify: vi.fn(async () => ({ decision: 'escalate' as const, reason: 'unsure' })) }
  const createJudge = vi.fn(() => pickedJudge)
  return { sessionJudge, pickedJudge, createJudge, wrapped: withAutoReviewModel(sessionJudge, () => picked, resolve, createJudge) }
}

describe('withAutoReviewModel', () => {
  it("uses the session's judge when no model is picked", async () => {
    const { sessionJudge, createJudge, wrapped } = setup('')
    await wrapped.classify(input)
    expect(sessionJudge.classify).toHaveBeenCalledWith(input)
    expect(createJudge).not.toHaveBeenCalled()
  })

  it('judges with the judge built for the picked model and returns its verdict', async () => {
    const { sessionJudge, createJudge, wrapped } = setup('vercel/steady')
    await expect(wrapped.classify(input)).resolves.toEqual({ decision: 'escalate', reason: 'unsure' })
    expect(createJudge).toHaveBeenCalledWith(pickedModel)
    expect(sessionJudge.classify).not.toHaveBeenCalled()
  })

  it('keeps one judge per model, so it remembers failures across calls', async () => {
    const { pickedJudge, createJudge, wrapped } = setup('vercel/steady')
    await wrapped.classify(input)
    await wrapped.classify(input)
    expect(createJudge).toHaveBeenCalledTimes(1)
    expect(pickedJudge.classify).toHaveBeenCalledTimes(2)
  })

  it("falls back to the session's judge when the pick can't be resolved", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { sessionJudge, createJudge, wrapped } = setup('gone/model', async () => { throw new Error('no such provider') })
    await wrapped.classify(input)
    expect(sessionJudge.classify).toHaveBeenCalledWith(input)
    expect(createJudge).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
