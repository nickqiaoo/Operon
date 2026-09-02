import { FormattedMessage } from 'react-intl';
import { UsersRound } from 'lucide-react';
import { UserMessageText } from './UserMessageText';

/**
 * A message another agent sent through the Teams hub, as it lands in this conversation.
 *
 * A teammate's report reaches the lead (and a lead's assignment reaches the teammate) as a
 * user-role message — that is the only way text gets in front of a model. Rendering it as a
 * user bubble would be a lie: nobody typed it, and in a team of several it matters WHICH
 * teammate is talking. So it gets its own card, stamped with the sender's name.
 *
 * The body goes through `UserMessageText` rather than markdown: this is another agent's text
 * verbatim, and a report that happens to start a line with `#` or `-` should read as it was
 * written, not get re-typeset as a heading or a list.
 */
export function PeerMessage({ from, text }: { from: string; text: string }) {
  return (
    <div className="mt-1 overflow-hidden rounded-xl border border-border/40 bg-muted/10">
      <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
        <UsersRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{from}</span>
        <span className="truncate text-xs text-muted-foreground">
          <FormattedMessage id="editor.peerMessage.label" defaultMessage="teammate message" />
        </span>
      </div>
      <div className="px-4 py-3 text-sm">
        <UserMessageText text={text} />
      </div>
    </div>
  );
}
