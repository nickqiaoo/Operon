import type { AutoApprover, ChatModel } from 'operon-agents'
import type { AutoApprovalInput, DecisionModel } from 'operon-agents/advanced'

type ReviewModel = ChatModel | DecisionModel

/**
 * Runs the Auto-mode judge on the model picked in Settings instead of the session's own, so a
 * session on a cheap or rate-limited model isn't also judged by it. The setting is read on every
 * call, so a change applies to sessions already open. A pick that can't be resolved (its provider
 * was removed, say) falls back to the session's model: a judge that can't run turns Auto into
 * asking about every step.
 *
 * `createJudge` picks the judge that fits the model. Each model keeps its judge, because a judge
 * remembers recent failures to stop calling a model that is down; `resolve` should return the same
 * object for as long as the pick and its provider config stay the same.
 */
export function withAutoReviewModel(
  sessionJudge: AutoApprover,
  pickedModelId: () => string,
  resolve: (modelId: string) => Promise<ReviewModel>,
  createJudge: (model: ReviewModel) => AutoApprover,
): AutoApprover {
  const judges = new WeakMap<ReviewModel, AutoApprover>()
  const judgeFor = (model: ReviewModel) => {
    const judge = judges.get(model) ?? createJudge(model)
    judges.set(model, judge)
    return judge
  }
  return {
    classify: async (input: AutoApprovalInput) => {
      const modelId = pickedModelId()
      if (!modelId) return sessionJudge.classify(input)
      let model: ReviewModel
      try {
        model = await resolve(modelId)
      } catch (error) {
        console.warn(`[operon] auto-review model ${modelId} is unavailable, using the session's: ${error instanceof Error ? error.message : String(error)}`)
        return sessionJudge.classify(input)
      }
      return judgeFor(model).classify(input)
    },
  }
}
