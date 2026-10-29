import { FormattedMessage } from 'react-intl';
import { UsersRound } from 'lucide-react';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent, MessageHeader } from '@/components/ui/message';
import { UserMessageText } from './UserMessageText';

/**
 * A message another agent sent through the Teams hub, as it lands in this conversation.
 *
 * A teammate's report reaches the lead (and a lead's assignment reaches the teammate) as a
 * user-role message — that is the only way text gets in front of a model. Rendering it as a
 * user bubble would be a lie: nobody typed it, and in a team of several it matters WHICH
 * teammate is talking. So it is a message from the other side: an outline bubble on the
 * agent's side of the column, under a header with the sender's name (shadcn Message).
 *
 * The body goes through `UserMessageText` rather than markdown: this is another agent's text
 * verbatim, and a report that happens to start a line with `#` or `-` should read as it was
 * written, not get re-typeset as a heading or a list.
 */
export function PeerMessage({ from, text }: { from: string; text: string }) {
  return (
    <Message className="mt-1">
      <MessageContent className="gap-1.5">
        <MessageHeader className="gap-1.5 px-0">
          <UsersRound className="size-3.5 shrink-0" />
          <span className="truncate text-foreground">{from}</span>
          <span className="truncate font-normal">
            <FormattedMessage id="editor.peerMessage.label" defaultMessage="teammate message" />
          </span>
        </MessageHeader>
        <Bubble variant="outline" className="max-w-full">
          <BubbleContent>
            <UserMessageText text={text} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
