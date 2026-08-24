import { FormattedMessage } from "react-intl"
import { Minus, Plus, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { DiffScope } from "./types"

export function BulkActionPill({
  scope,
  onStageAll,
  onUnstageAll,
  onRevertAll,
}: {
  scope: DiffScope
  onStageAll: () => void
  onUnstageAll: () => void
  onRevertAll: () => void
}) {
  const isStaged = scope === "staged"
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/50 bg-background/90 p-1 shadow-float backdrop-blur">
        {isStaged ? (
          <PillButton onClick={onUnstageAll} icon={<Minus className="h-3.5 w-3.5" />}>
            Unstage all
          </PillButton>
        ) : (
          <>
            <PillButton onClick={onRevertAll} icon={<Undo2 className="h-3.5 w-3.5" />}>
              Revert all
            </PillButton>
            <PillButton onClick={onStageAll} icon={<Plus className="h-3.5 w-3.5" />}>
              Stage all
            </PillButton>
          </>
        )}
      </div>
    </div>
  )
}

export function PillButton({
  onClick,
  icon,
  children,
}: {
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
    >
      {icon}
      {children}
    </button>
  )
}

export function RevertAllConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage id="review.revertAll.title" defaultMessage="Revert all changes?" />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="review.revertAll.desc"
              defaultMessage="This discards every unstaged change in the working tree and moves untracked files to the trash. This can't be undone."
            />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-t border-border/40 pt-4">
          <Button size="sm" variant="ghost" className="h-8" onClick={() => onOpenChange(false)}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button size="sm" variant="destructive" className="h-8" onClick={onConfirm}>
            <FormattedMessage id="review.revertAll.confirm" defaultMessage="Revert all" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

