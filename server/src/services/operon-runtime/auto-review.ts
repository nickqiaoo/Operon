import type { AutoApprovalInput, AutoApprover, ChatModel } from 'operon-agents-core'

/**
 * Runs the Auto-mode judge on the model picked in Settings instead of the session's own, so a
 * session on a cheap or rate-limited model isn't also judged by it. The setting is read on every
 * call, so a change applies to sessions already open. A pick that can't be resolved (its provider
 * was removed, say) falls back to the session's model: a judge that can't run turns Auto into
 * asking about every step.
 */
export function withAutoReviewModel(
  judge: AutoApprover,
  pickedModelId: () => string,
  resolve: (modelId: string) => Promise<ChatModel>,
): AutoApprover {
  return {
    classify: async (input: AutoApprovalInput) => {
      const modelId = pickedModelId()
      if (!modelId) return judge.classify(input)
      let model: ChatModel
      try {
        model = await resolve(modelId)
      } catch (error) {
        console.warn(`[operon] auto-review model ${modelId} is unavailable, using the session's: ${error instanceof Error ? error.message : String(error)}`)
        return judge.classify(input)
      }
      return judge.classify({ ...input, ctx: { ...input.ctx, model } })
    },
  }
}
