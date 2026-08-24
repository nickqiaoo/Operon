interface ComposerDraftState {
  input: string
  attachmentCount: number
  selectedSkillCount: number
  hasPendingContext: boolean
}

export const hasComposerDraft = ({
  input,
  attachmentCount,
  selectedSkillCount,
  hasPendingContext,
}: ComposerDraftState): boolean =>
  input.trim().length > 0 ||
  attachmentCount > 0 ||
  selectedSkillCount > 0 ||
  hasPendingContext
