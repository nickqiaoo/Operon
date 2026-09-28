import { createContext, useContext } from 'react';

/**
 * The server-side id of the conversation being rendered — what `/api/ai/chat/:chatId/…`
 * takes, not the tab id. Undefined before the chat has been saved once.
 *
 * Provided around the transcript so deep renderers (a sub-agent card fetching its
 * steps) can reach it without every layer in between passing it along.
 */
export const ChatDbIdContext = createContext<number | undefined>(undefined);

export function useChatDbId(): number | undefined {
  return useContext(ChatDbIdContext);
}
