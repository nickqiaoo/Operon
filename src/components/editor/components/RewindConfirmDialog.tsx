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
import type { RewindSkippedFile } from '@/lib/api'

export function RewindConfirmDialog({
  open,
  onOpenChange,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle><FormattedMessage id="editor.rewind.title" defaultMessage="Confirm Rewind" /></DialogTitle>
          <DialogDescription>
            <FormattedMessage id="editor.rewind.desc1" defaultMessage="This will rewind the files this chat changed back to the selected checkpoint. Changes made after that point — by this chat or by you — will be lost." />
            <br /><br />
            <FormattedMessage id="editor.rewind.scope" defaultMessage="Files changed by other chat tabs are left alone. If any of them overlap with this chat's, you'll be asked before they are touched." />
            <br /><br />
            <FormattedMessage id="editor.rewind.desc2" defaultMessage='You can undo this operation using the "Undo" button that will appear at the checkpoint.' />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}><FormattedMessage id="common.cancel" defaultMessage="Cancel" /></Button>
          <Button size="sm" variant="destructive" className="h-8" onClick={onConfirm}><FormattedMessage id="editor.rewind.confirm" defaultMessage="Rewind" /></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const REASON_MESSAGES = {
  'modified-by-others': {
    id: 'editor.rewind.conflict.modified',
    defaultMessage: 'changed after this chat last wrote it',
  },
  'concurrent-turn': {
    id: 'editor.rewind.conflict.concurrent',
    defaultMessage: 'another chat was running at the same time',
  },
  'unbounded-turn': {
    id: 'editor.rewind.conflict.unbounded',
    defaultMessage: "that turn never finished recording, so its changes can't be told apart",
  },
} as const

/**
 * Second pass: the rewind already reverted everything it could safely claim,
 * and these files were left as they are. Reverting them overwrites content this
 * chat cannot prove it wrote, so it takes an explicit confirmation.
 */
export function RewindConflictDialog({
  files,
  onOpenChange,
  onDismiss,
  onConfirm,
}: {
  files: RewindSkippedFile[] | null
  onOpenChange: (open: boolean) => void
  onDismiss: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={files !== null && files.length > 0} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage id="editor.rewind.conflict.title" defaultMessage="Some files were left untouched" />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="editor.rewind.conflict.desc"
              defaultMessage="The rewind finished, but {count, plural, one {# file} other {# files}} could not be attributed to this chat and were kept as they are. Reverting them would discard changes this chat did not make."
              values={{ count: files?.length ?? 0 }}
            />
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-56 overflow-y-auto rounded-md border border-border/40 text-sm">
          {files?.map((file) => (
            <li key={file.path} className="border-b border-border/20 px-3 py-2 last:border-b-0">
              <div className="font-mono text-xs break-all">{file.path}</div>
              <div className="text-muted-foreground text-xs">
                <FormattedMessage {...REASON_MESSAGES[file.reason]} />
              </div>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button size="sm" variant="ghost" className="h-8" onClick={onDismiss}>
            <FormattedMessage id="editor.rewind.conflict.keep" defaultMessage="Keep them" />
          </Button>
          <Button size="sm" variant="destructive" className="h-8" onClick={onConfirm}>
            <FormattedMessage id="editor.rewind.conflict.revert" defaultMessage="Revert anyway" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
