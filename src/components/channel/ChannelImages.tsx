import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { ImageIcon } from 'lucide-react'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { ImageViewer } from '@/components/ai-elements/image-viewer'
import { useAuthedObjectUrl } from '@/hooks/useAuthedObjectUrl'
import { getBaseUrl, getBaseUrlSync } from '@/lib/api-client'
import { isAttachmentUrl, resolveAttachmentUrl } from '@/lib/attachments'
import { cn } from '@/lib/utils'
import type { ChannelAttachment } from '@/types/channel'

/**
 * Images on a channel message, shown at a readable size in their own aspect
 * ratio — a screenshot someone posts is the message, not a chip beside it
 * (the board's 80px cards turned a wide screenshot into an unreadable square).
 * One image gets the most room; several share a row at a smaller height.
 * Clicking one opens the full-size viewer.
 */
export function ChannelImages({ attachments, align = 'start', className }: {
  attachments: ChannelAttachment[]
  align?: 'start' | 'end'
  className?: string
}) {
  if (attachments.length === 0) return null
  const single = attachments.length === 1
  return (
    <div className={cn('flex flex-wrap gap-2', align === 'end' && 'justify-end', className)}>
      {attachments.map((a, i) => (
        <ChannelImage key={`${a.url}:${i}`} attachment={a} single={single} />
      ))}
    </div>
  )
}

function ChannelImage({ attachment, single }: { attachment: ChannelAttachment; single: boolean }) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  // A stored attachment's URL needs the node's base URL; re-render once it is known.
  const [baseUrlReady, setBaseUrlReady] = useState(() => getBaseUrlSync() !== null)
  useEffect(() => {
    if (baseUrlReady) return
    let active = true
    void getBaseUrl().then(() => { if (active) setBaseUrlReady(true) }).catch(() => {})
    return () => { active = false }
  }, [baseUrlReady])

  const resolved = isAttachmentUrl(attachment.url) ? resolveAttachmentUrl(attachment.url) : attachment.url
  // On web the broker needs a bearer header an <img src> can't carry, so the
  // bytes are fetched and shown from a blob: URL (same as AttachmentPreview).
  const viaBroker = __APP_TARGET__ === 'web' && isAttachmentUrl(attachment.url) ? resolved : null
  const objectUrl = useAuthedObjectUrl(viaBroker)
  const src = viaBroker ? objectUrl : resolved
  const name = attachment.filename || intl.formatMessage({ id: 'channel.image.fallbackName', defaultMessage: 'Image' })

  const frame = cn(
    'overflow-hidden rounded-lg border border-border/50 bg-muted/40 dark:border-border/35',
    single ? 'max-w-full sm:max-w-sm' : 'max-w-[min(100%,14rem)]',
  )

  if (!src) {
    return (
      <div className={cn(frame, 'flex size-24 items-center justify-center text-muted-foreground/60')}>
        <ImageIcon className="size-5" />
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(frame, 'block cursor-zoom-in transition-opacity hover:opacity-90')}
          aria-label={intl.formatMessage({ id: 'channel.image.open', defaultMessage: 'Open {name}' }, { name })}
        >
          <img
            src={src}
            alt={name}
            loading="lazy"
            className={cn('block h-auto w-auto max-w-full object-contain', single ? 'max-h-72' : 'max-h-40')}
          />
        </button>
      </DialogTrigger>
      {open && <ImageViewer src={src} filename={attachment.filename} />}
    </Dialog>
  )
}
