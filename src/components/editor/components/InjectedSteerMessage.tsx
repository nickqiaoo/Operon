import { createContext, useContext } from 'react';
import type { FileUIPart } from 'ai';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { Attachment, AttachmentPreview, Attachments } from '@/components/ai-elements/attachments';
import { UserMessageText } from './UserMessageText';
import type { InjectedInputData } from './steer-message';

/**
 * Attachments of the follow-ups sent mid-turn, by steer message id. The reply marks
 * where the agent read a follow-up with its text only (`data-injected-input`), and
 * the steer row that holds the images is hidden in its favour, so the bubble looks
 * them up here.
 */
export const SteerAttachmentsContext = createContext<ReadonlyMap<string, readonly FileUIPart[]>>(new Map());

/** A follow-up the user sent mid-turn, at the point the agent read it. */
export function InjectedSteerMessage({ injected }: { injected: InjectedInputData }) {
  const files = useContext(SteerAttachmentsContext).get(injected.id);
  return (
    <>
      {files && files.length > 0 ? (
        <Message from="user" data-testid="injected-steer-attachments">
          {/* The cards are their own surface: no bubble around them. */}
          <MessageContent variant="none">
            <Attachments>
              {files.map((file, index) => (
                <Attachment key={`${injected.id}-attachment-${index}`} data={{ ...file, id: `${injected.id}-attachment-${index}` }}>
                  <AttachmentPreview />
                </Attachment>
              ))}
            </Attachments>
          </MessageContent>
        </Message>
      ) : null}
      {injected.text.trim() ? (
        <Message from="user" data-testid="injected-steer">
          <MessageContent>
            <UserMessageText text={injected.text} />
          </MessageContent>
        </Message>
      ) : null}
    </>
  );
}
