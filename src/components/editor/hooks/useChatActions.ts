import { api } from "@/lib/api";
import { persistBlobUrl } from "@/lib/attachments";
import { wrapContextBlock } from "@/lib/context-blocks";
import type { FileUIPart } from 'ai';
import { useCallback } from 'react';

type ChatTabOptions = {
  autoRun?: boolean
  background?: boolean
  timestamp?: number
  input?: string
  modelId?: string
  inputAttachment?: FileUIPart & { id: string; content?: string; asText?: boolean }
}

type SendMessageInput = {
  text: string
  files?: Array<FileUIPart & { content?: string }>
} | {
  files: Array<FileUIPart & { content?: string }>
}

/**
 * Blob URLs are session-scoped object references — they die with the page, so
 * anything persisted in a transcript has to be turned into something durable
 * first. Uploads to the attachment store, falling back to an inline data URL.
 */
const persistFileUrl = async (
  url: string,
  meta: { filename?: string; mediaType?: string },
): Promise<string> => {
  if (!url.startsWith('blob:')) return url;
  return (await persistBlobUrl(url, meta)) ?? url;
};

const stripAttachmentMeta = (
  files: Array<FileUIPart & { id?: string; content?: string; asText?: boolean }>
): Array<FileUIPart & { content?: string; asText?: boolean }> =>
  files.map(({ id: _id, ...rest }) => rest);

export function useChatActions(
  sendMessage: (input: SendMessageInput) => Promise<void> | void,
  openChatTab: (chatId: string, title?: string, options?: ChatTabOptions, providerId?: string) => void,
  defaultProviderId?: string
) {
  const handleSubmit = useCallback(async (
    message: { text: string; files: FileUIPart[] },
    attachmentsFiles: Array<FileUIPart & { id?: string; content?: string }>,
    setInput: (val: string) => void
  ) => {
    const allFiles = (message.files && message.files.length > 0)
      ? message.files
      : (attachmentsFiles.length > 0 ? stripAttachmentMeta(attachmentsFiles) : []);

    // Separate asText attachments from real file attachments
    const textSnippets: string[] = [];
    const effectiveFiles: Array<FileUIPart & { content?: string }> = [];
    for (const file of allFiles) {
      const fileContent = 'content' in file ? file.content : undefined;
      if ('asText' in file && file.asText && typeof fileContent === 'string' && fileContent) {
        const filename = 'filename' in file ? file.filename : undefined;
        // Fenced with a closing marker so the transcript can split the quote
        // back out from what the user typed (see `parseContextBlocks`).
        textSnippets.push(filename ? wrapContextBlock(filename, fileContent) : fileContent);
      } else {
        effectiveFiles.push(file);
      }
    }

    // Merge text snippets with the message text
    const combinedText = [...textSnippets, message.text].filter(Boolean).join('\n\n');

    const hasText = !!combinedText.trim();
    const hasFiles = effectiveFiles.length > 0;

    if (!hasText && !hasFiles) return;
    setInput('');

    const normalizedFiles = await Promise.all(
      effectiveFiles.map(async (file) => ({
        ...file,
        url: await persistFileUrl(file.url, {
          filename: file.filename,
          mediaType: file.mediaType,
        }),
      }))
    );

    void sendMessage(
      hasText
        ? { text: combinedText, files: normalizedFiles }
        : { files: normalizedFiles }
    );
  }, [sendMessage]);

  const handleSendTo = useCallback(async (modelId: string, providerId: string | undefined, text: string) => {
    const resolvedProviderId = providerId ?? defaultProviderId;
    if (!resolvedProviderId) {
      console.error('Missing providerId for send-to model:', modelId);
      return;
    }

    const tabId = `chat:${crypto.randomUUID()}`;
    openChatTab(
      tabId,
      text.slice(0, 20),
      {
        autoRun: true,
        background: true,
        input: text,
        modelId,
        timestamp: Date.now(),
      },
      resolvedProviderId
    );
  }, [defaultProviderId, openChatTab]);

  const handleSendToTab = useCallback(async (targetChatId: string, text: string) => {
    const filename = `pasted_text_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

    // Try to save as temp file first, fall back to data URL
    let url: string;
    try {
      url = await api.saveTempFile(text, '.txt');
    } catch (e) {
      console.error('Failed to save temp file, falling back to data URL', e);
      url = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
    }

    openChatTab(targetChatId, undefined, {
      background: false,
      inputAttachment: {
        type: 'file',
        id: crypto.randomUUID(),
        mediaType: 'text/plain',
        filename,
        url,
        content: text,
      }
    });
  }, [openChatTab]);

  return {
    handleSubmit,
    handleSendTo,
    handleSendToTab,
  };
}
