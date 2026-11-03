import { useCallback, type PropsWithChildren } from 'react';
import { PromptInputProvider, type PromptInputFile } from '@/components/ai-elements/prompt-input-context';
import { getChatDraft, getChatDraftFiles, setChatDraft, setChatDraftFiles } from '@/lib/chat-drafts';

export function ChatInputProvider({ chatId, children }: PropsWithChildren<{ chatId: string }>) {
  const saveDraft = useCallback((text: string) => setChatDraft(chatId, text), [chatId]);
  const saveFiles = useCallback((files: PromptInputFile[]) => setChatDraftFiles(chatId, files), [chatId]);
  return (
    <PromptInputProvider
      key={chatId}
      initialInput={getChatDraft(chatId)}
      onInputChange={saveDraft}
      initialAttachments={getChatDraftFiles(chatId)}
      onAttachmentsChange={saveFiles}
    >
      {children}
    </PromptInputProvider>
  );
}
