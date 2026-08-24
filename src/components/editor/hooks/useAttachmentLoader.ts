import { useLayoutEffect } from 'react';
import type { AttachmentInput } from '@/components/ai-elements/prompt-input';
import type { InputAttachment } from '@/types/editor';

const toAttachmentInput = (attachment: InputAttachment): AttachmentInput => ({
  url: attachment.url,
  name: attachment.filename ?? 'attachment',
  type: attachment.mediaType,
  id: attachment.id,
  content: attachment.content,
  asText: attachment.asText,
});

export function useAttachmentLoader(
  inputAttachment: InputAttachment | undefined,
  chatId: string,
  attachmentsAdd: (files: AttachmentInput[] | FileList) => void,
  clearTabInputAttachment: (chatId: string) => void
) {
  useLayoutEffect(() => {
    if (!inputAttachment) return;

    // Convert to PromptInput attachment shape before adding
    attachmentsAdd([toAttachmentInput(inputAttachment)]);
    clearTabInputAttachment(chatId);
  }, [inputAttachment?.id, attachmentsAdd, clearTabInputAttachment, chatId]);
}
