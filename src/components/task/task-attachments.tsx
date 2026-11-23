import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent } from 'react'
import { useIntl } from 'react-intl'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Attachment, AttachmentPreview, AttachmentRemove, Attachments } from '@/components/ai-elements/attachments'
import { uploadFile } from '@/lib/attachments'
import { cn } from '@/lib/utils'
import type { TaskAttachment } from '@/types/task'

/**
 * Images on a board task — pasted or dropped into the new-task description,
 * the description editor, or the comment composer. They upload to the
 * attachment store as soon as they land, and the stored paths travel with the
 * task / comment, so the agent receives them as file parts.
 */

const MAX_IMAGES = 20

interface PendingImage {
  id: string
  /** blob: URL for the thumbnail while it uploads. */
  previewUrl: string
  filename: string
  mediaType: string
  uploaded: TaskAttachment | null
}

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
}

export interface ImageUploads {
  items: PendingImage[]
  /** Uploaded and ready to send. */
  attachments: TaskAttachment[]
  uploading: boolean
  remove: (id: string) => void
  clear: () => void
  /** Add picked files (a file input); non-images are ignored. */
  addFiles: (files: FileList | File[] | null | undefined) => void
  /** Wire onto a textarea: pasting or dropping images adds them; text pastes are left alone. */
  inputProps: {
    onPaste: (e: ClipboardEvent<HTMLElement>) => void
    onDrop: (e: DragEvent<HTMLElement>) => void
    onDragOver: (e: DragEvent<HTMLElement>) => void
  }
}

/**
 * `onUploaded`: each image is handed over as soon as it is stored and drops out
 * of `items` (the description editor saves it to the task right away). Without
 * it, images accumulate until `clear()` (composers send them with the message).
 */
export function useImageUploads(options: { onUploaded?: (a: TaskAttachment) => void; maxImages?: number } = {}): ImageUploads {
  const intl = useIntl()
  const [items, setItems] = useState<PendingImage[]>([])
  const itemsRef = useRef<PendingImage[]>([])
  const maxImages = options.maxImages ?? MAX_IMAGES
  const onUploadedRef = useRef(options.onUploaded)
  onUploadedRef.current = options.onUploaded

  // Thumbnails still on screen hold blob: URLs; free them when the composer goes away.
  useEffect(() => () => {
    for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl)
    itemsRef.current = []
  }, [])

  const drop = useCallback((id: string) => {
    const gone = itemsRef.current.find((item) => item.id === id)
    if (!gone) return
    URL.revokeObjectURL(gone.previewUrl)
    itemsRef.current = itemsRef.current.filter((item) => item.id !== id)
    setItems(itemsRef.current)
  }, [])

  const add = useCallback((files: File[]) => {
    const room = maxImages - itemsRef.current.length
    if (room <= 0) return
    for (const file of files.slice(0, room)) {
      const item: PendingImage = {
        id: crypto.randomUUID(),
        previewUrl: URL.createObjectURL(file),
        filename: file.name || 'image.png',
        mediaType: file.type,
        uploaded: null,
      }
      itemsRef.current = [...itemsRef.current, item]
      void uploadFile(file).then((stored) => {
        if (!itemsRef.current.some((pending) => pending.id === item.id)) return
        if (!stored) {
          drop(item.id)
          toast.error(intl.formatMessage({ id: 'task.attachments.uploadFailed', defaultMessage: 'Image upload failed' }))
          return
        }
        const attachment: TaskAttachment = { url: stored.url, mediaType: stored.mediaType || item.mediaType, filename: item.filename }
        if (onUploadedRef.current) {
          onUploadedRef.current(attachment)
          drop(item.id)
          return
        }
        itemsRef.current = itemsRef.current.map((i) => (i.id === item.id ? { ...i, uploaded: attachment } : i))
        setItems(itemsRef.current)
      })
    }
    setItems(itemsRef.current)
  }, [drop, intl, maxImages])

  const onPaste = useCallback((e: ClipboardEvent<HTMLElement>) => {
    const files = imageFiles(e.clipboardData?.files)
    if (files.length === 0) return
    e.preventDefault()
    add(files)
  }, [add])

  const onDrop = useCallback((e: DragEvent<HTMLElement>) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    const files = imageFiles(e.dataTransfer?.files)
    if (files.length === 0) return
    e.preventDefault()
    add(files)
  }, [add])

  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file')) e.preventDefault()
  }, [])

  const clear = useCallback(() => {
    for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl)
    itemsRef.current = []
    setItems(itemsRef.current)
  }, [])

  const addFiles = useCallback((files: FileList | File[] | null | undefined) => {
    const images = Array.isArray(files) ? files.filter((f) => f.type.startsWith('image/')) : imageFiles(files)
    if (images.length > 0) add(images)
  }, [add])

  return {
    items,
    attachments: items.flatMap((i) => (i.uploaded ? [i.uploaded] : [])),
    uploading: items.some((i) => !i.uploaded),
    remove: drop,
    clear,
    addFiles,
    inputProps: { onPaste, onDrop, onDragOver },
  }
}

/** Thumbnails of images being attached; a spinner sits on each until it is stored. */
export function PendingImageStrip({ uploads, className }: { uploads: ImageUploads; className?: string }) {
  const intl = useIntl()
  if (uploads.items.length === 0) return null
  return (
    <Attachments className={cn('ml-0', className)}>
      {uploads.items.map((item) => (
        <Attachment
          key={item.id}
          className="w-16"
          data={{ type: 'file', id: item.id, url: item.previewUrl, mediaType: item.mediaType, filename: item.filename }}
          onRemove={() => uploads.remove(item.id)}
        >
          <div className="relative">
            <AttachmentPreview />
            {!item.uploaded && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
          <AttachmentRemove label={intl.formatMessage({ id: 'task.attachments.remove', defaultMessage: 'Remove image' })} />
        </Attachment>
      ))}
    </Attachments>
  )
}

/** Stored images on a task or comment; `onRemove` adds a remove action to each. */
export function TaskImageStrip({
  attachments,
  onRemove,
  className,
}: {
  attachments: TaskAttachment[]
  onRemove?: (index: number) => void
  className?: string
}) {
  const intl = useIntl()
  if (attachments.length === 0) return null
  return (
    <Attachments className={cn('ml-0', className)}>
      {attachments.map((a, index) => (
        <Attachment
          key={`${a.url}:${index}`}
          className="w-20"
          data={{ type: 'file', id: `${a.url}:${index}`, url: a.url, mediaType: a.mediaType, filename: a.filename }}
          onRemove={onRemove ? () => onRemove(index) : undefined}
        >
          <AttachmentPreview />
          <AttachmentRemove label={intl.formatMessage({ id: 'task.attachments.remove', defaultMessage: 'Remove image' })} />
        </Attachment>
      ))}
    </Attachments>
  )
}
