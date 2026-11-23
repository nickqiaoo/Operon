import { useState } from 'react'
import { useImageUploads } from '@/components/task/task-attachments'
import type { ChannelAttachment } from '@/types/channel'

/**
 * The channel / thread composer's draft. Sending clears it at once and hands the
 * message to `send`, which shows it in the transcript straight away and marks it
 * there if the server never takes it (with retry) — like the assistant. Waiting
 * for the POST before clearing left the text sitting in the box for the whole
 * round trip, which over the relay on a phone is seconds.
 */
export function useChannelComposer(send: (content: string, attachments: ChannelAttachment[]) => Promise<void>) {
  const [input, setInput] = useState('')
  const images = useImageUploads({ maxImages: 10 })
  const canSend = !!(input.trim() || images.attachments.length) && !images.uploading

  function submit(text = input) {
    const content = text.trim()
    if (images.uploading || (!content && images.attachments.length === 0)) return false
    const attachments = images.attachments
    setInput('')
    for (const item of images.items) images.remove(item.id)
    send(content, attachments).catch((error: unknown) => console.error(error))
    return true
  }

  return { input, setInput, images, canSend, submit }
}
