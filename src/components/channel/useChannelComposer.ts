import { useRef, useState } from 'react'
import { useImageUploads } from '@/components/task/task-attachments'
import type { ChannelAttachment } from '@/types/channel'

export function useChannelComposer(send: (content: string, attachments: ChannelAttachment[]) => Promise<void>) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)
  const submitting = useRef(false)
  const images = useImageUploads({ maxImages: 10 })
  const canSend = !!(input.trim() || images.attachments.length) && !images.uploading && !sending

  async function submit(text = input) {
    const content = text.trim()
    if (submitting.current || images.uploading || (!content && images.attachments.length === 0)) return false

    submitting.current = true
    setSending(true)
    setSendFailed(false)
    try {
      await send(content, images.attachments)
      setInput((draft) => draft === text ? '' : draft)
      for (const item of images.items) images.remove(item.id)
      return true
    } catch (error) {
      console.error(error)
      setSendFailed(true)
      return false
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  return { input, setInput, images, sending, sendFailed, canSend, submit }
}
