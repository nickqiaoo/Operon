import type { ReactNode } from 'react'
import { MobileSheet } from '@/components/mobile/MobileSheet'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useBackHandler } from '@/hooks/useAndroidBackButton'
import { useIsMobileShell } from '@/hooks/useIsMobile'

export function ChannelDialog({ open, onClose, className, flush, children }: {
  open: boolean
  onClose: () => void
  className: string
  flush?: boolean
  children: ReactNode
}) {
  const mobile = useIsMobileShell()
  useBackHandler(mobile && open, onClose)
  if (mobile) {
    return (
      <MobileSheet open={open} onClose={onClose} showClose={false} titleInBody
        sheetClassName="flex max-h-[90dvh] flex-col"
        bodyClassName={flush ? 'flex min-h-0 max-h-none flex-col p-0' : 'flex min-h-0 max-h-none flex-col gap-3 p-6 pt-3'}
      >
        {children}
      </MobileSheet>
    )
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className={className} showCloseButton={false}>{children}</DialogContent>
    </Dialog>
  )
}
