import type { PromptInputFile } from "@/components/ai-elements/prompt-input-context"
import type { SlashCommandItem } from "@/components/editor/hooks/useModelManagement"

interface ChatDraft {
  text: string
  files?: PromptInputFile[]
  skills?: SlashCommandItem[]
  appliedInputKey?: string
}

// Session-only drafts survive ChatPanel unmounts, without browser storage.
const drafts = new Map<string, ChatDraft>()

function update(chatId: string, patch: Partial<ChatDraft>): void {
  drafts.set(chatId, { text: "", ...drafts.get(chatId), ...patch })
}

export function getChatDraft(chatId: string): string {
  return drafts.get(chatId)?.text ?? ""
}

export function setChatDraft(chatId: string, text: string): void {
  update(chatId, { text })
}

export function getChatDraftFiles(chatId: string): PromptInputFile[] {
  return drafts.get(chatId)?.files ?? []
}

/**
 * The draft owns these files' blob URLs once the composer unmounts, so the
 * provider stops revoking them on unmount and `clearChatDraft` does it instead.
 */
export function setChatDraftFiles(chatId: string, files: PromptInputFile[]): void {
  update(chatId, { files })
}

export function getChatDraftSkills(chatId: string): SlashCommandItem[] {
  return drafts.get(chatId)?.skills ?? []
}

export function setChatDraftSkills(chatId: string, skills: SlashCommandItem[]): void {
  update(chatId, { skills })
}

/** Remember prefilled prompts too, so remounting cannot overwrite edited text. */
export function claimChatInput(chatId: string, inputKey: string): boolean {
  if (drafts.get(chatId)?.appliedInputKey === inputKey) return false
  update(chatId, { appliedInputKey: inputKey })
  return true
}

export function clearChatDraft(chatId: string): void {
  for (const file of drafts.get(chatId)?.files ?? []) {
    if (file.url?.startsWith("blob:")) URL.revokeObjectURL(file.url)
  }
  drafts.delete(chatId)
}
