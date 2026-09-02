import { FormattedMessage } from 'react-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { PeerTeamDTO } from '@/types/peers'

/**
 * Disbanding is not undoable and not always quiet.
 *
 * It closes every teammate's session — a teammate mid-task is cut off, not waited for —
 * and settles whatever is still sitting in their mailboxes, so a message the lead sent
 * but nobody has consumed yet is dropped rather than delivered. Neither is visible from
 * the button, which is why it takes a confirmation: the counts here are the two facts
 * that decide whether now is a good moment.
 *
 * Transcripts survive, and saying so is half the point of the dialog — without it the
 * safe reading of "disband" is that the conversations go too.
 */
export function DisbandConfirmDialog({
  team,
  onOpenChange,
  onCancel,
  onConfirm,
}: {
  team: PeerTeamDTO | null
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const members = team?.members ?? []
  const running = members.filter((m) => m.status === 'running').length

  return (
    <Dialog open={team !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="editor.team.disband.title"
              defaultMessage="Disband {name}?"
              values={{ name: team?.name ?? '' }}
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="editor.team.disband.desc"
              defaultMessage="Closes {count, plural, =0 {the team} one {# teammate's session} other {# teammates' sessions}} and frees their names. Undelivered messages between them are dropped."
              values={{ count: members.length }}
            />
            {running > 0 && (
              <>
                <br />
                <br />
                <span className="text-status-warn">
                  <FormattedMessage
                    id="editor.team.disband.running"
                    defaultMessage="{count, plural, one {# teammate is} other {# teammates are}} working right now and will be cut off mid-task."
                    values={{ count: running }}
                  />
                </span>
              </>
            )}
            <br />
            <br />
            <FormattedMessage
              id="editor.team.disband.transcripts"
              defaultMessage="Their conversations are kept — you can still open and read them afterwards."
            />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button size="sm" variant="destructive" className="h-8" onClick={onConfirm}>
            <FormattedMessage id="editor.team.disband.confirm" defaultMessage="Disband" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
