import { useChatApi, useChatTransport } from "@/lib/chat-api-context";
import { localTransport, type ApiTransport } from "@/lib/api-client";
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
  transport: ApiTransport,
): Promise<string> => {
  if (!url.startsWith('blob:')) return url;
  return (await persistBlobUrl(url, meta, transport)) ?? url;
};

type OutgoingFile = FileUIPart & { id?: string; content?: string; asText?: boolean }

/**
 * What the composer hands the agent for a message: `asText` attachments folded
 * into the text as quoted context, the rest as file parts with durable URLs.
 * Shared by a new turn and a steer into the running one.
 */
export async function prepareOutgoingMessage(
  text: string,
  files: OutgoingFile[],
  /** The machine the chat lives on: its attachment store gets the uploads. */
  transport: ApiTransport = localTransport,
): Promise<{ text: string; files: Array<FileUIPart & { content?: string }> }> {
  const textSnippets: string[] = [];
  const effectiveFiles: Array<FileUIPart & { content?: string }> = [];
  for (const { id: _id, asText, ...file } of files) {
    if (asText && typeof file.content === 'string' && file.content) {
      // Fenced with a closing marker so the transcript can split the quote
      // back out from what the user typed (see `parseContextBlocks`).
      textSnippets.push(file.filename ? wrapContextBlock(file.filename, file.content) : file.content);
    } else {
      effectiveFiles.push(file);
    }
  }

  const normalizedFiles = await Promise.all(
    effectiveFiles.map(async (file) => ({
      ...file,
      url: await persistFileUrl(file.url, {
        filename: file.filename,
        mediaType: file.mediaType,
      }, transport),
    }))
  );

  return {
    text: [...textSnippets, text].filter(Boolean).join('\n\n'),
    files: normalizedFiles,
  };
}

export function useChatActions(
  sendMessage: (input: SendMessageInput) => Promise<void> | void,
  openChatTab: (chatId: string, title?: string, options?: ChatTabOptions, providerId?: string) => void,
  defaultProviderId?: string
) {
  const api = useChatApi();
  const transport = useChatTransport();
  const handleSubmit = useCallback(async (
    message: { text: string; files: FileUIPart[] },
    attachmentsFiles: Array<FileUIPart & { id?: string; content?: string }>,
    setInput: (val: string) => void
  ) => {
    const allFiles: OutgoingFile[] = (message.files && message.files.length > 0)
      ? message.files
      : attachmentsFiles;

    if (!message.text.trim() && allFiles.length === 0) return;
    setInput('');

    const prepared = await prepareOutgoingMessage(message.text, allFiles, transport);
    void sendMessage(
      prepared.text.trim()
        ? { text: prepared.text, files: prepared.files }
        : { files: prepared.files }
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
