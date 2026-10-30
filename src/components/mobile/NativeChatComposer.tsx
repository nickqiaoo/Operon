import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNativeShellOverlayCount } from '@/hooks/useNativeShellOverlay'
import { usePageVisible } from '@/lib/page-visibility'
import { NativeComposer, type NativeComposerState, type ComposerMenuItem, type ComposerSuggestion, type ComposerToken } from '@/lib/native-composer'
import { usePromptInputAttachments, usePromptInputSubmitting, usePromptInputSubmit } from '@/components/ai-elements/prompt-input'

interface NativeChatComposerProps {
  value: string
  onChange: (text: string, cursor: number) => void
  onSubmit: (text: string) => void
  placeholder?: string
  disabled?: boolean
  submitting?: boolean
  running?: boolean
  canSteer?: boolean
  hasContext?: boolean
  onStop?: () => void
  onSteer?: (text: string) => void
  menu?: ComposerMenuItem[]
  menuTitle?: string
  skills?: ComposerToken[]
  attachments?: ComposerToken[]
  suggestions?: ComposerSuggestion[]
  onAction?: (action: string) => void
  onFiles?: (files: File[]) => void
  active?: boolean
  /** A thread page already holds one shell-overlay slot itself. */
  overlayLevel?: number
}

/** The DOM keeps a spacer; UIKit owns editing, glass, hit testing and keyboard animation. */
export function NativeChatComposer(props: NativeChatComposerProps) {
  const id = useId()
  const anchor = useRef<HTMLDivElement>(null)
  const revision = useRef(0)
  const latest = useRef(props)
  latest.current = props
  const [height, setHeight] = useState(56)
  const [ready, setReady] = useState(false)
  const pageVisible = usePageVisible()
  const overlays = useNativeShellOverlayCount()
  const active = props.active !== false && pageVisible && overlays <= (props.overlayLevel ?? 0)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    let disposed = false
    const handles: Awaited<ReturnType<typeof NativeComposer.addListener>>[] = []
    const listen = async () => {
      handles.push(await NativeComposer.addListener('change', (event) => {
        if (event.id !== id || disposed) return
        revision.current = event.revision
        latest.current.onChange(event.text, event.cursor)
      }))
      handles.push(await NativeComposer.addListener('submit', (event) => {
        if (event.id !== id || disposed || !activeRef.current) return
        revision.current = event.revision
        // A send carries the native snapshot, including characters typed since the last draft sync.
        flushSync(() => latest.current.onChange(event.text, event.cursor))
        if (event.action === 'stop') latest.current.onStop?.()
        else if (event.action === 'steer') latest.current.onSteer?.(event.text)
        else latest.current.onSubmit(event.text)
      }))
      handles.push(await NativeComposer.addListener('action', (event) => {
        if (event.id !== id || disposed || !activeRef.current) return
        revision.current = event.revision
        flushSync(() => latest.current.onChange(event.text, event.cursor))
        latest.current.onAction?.(event.action)
      }))
      handles.push(await NativeComposer.addListener('resize', (event) => {
        if (event.id === id && !disposed) setHeight(event.height)
      }))
      handles.push(await NativeComposer.addListener('files', (event) => {
        if (event.id !== id || disposed) return
        void Promise.all(event.files.map(async (file) => {
          const blob = await (await fetch(file.url)).blob()
          return new File([blob], file.name, { type: file.type })
        })).then((files) => {
          if (!disposed) latest.current.onFiles?.(files)
        }).catch(console.error)
      }))
      if (disposed) handles.forEach((handle) => void handle.remove())
      else setReady(true)
    }
    void listen().catch(console.error)
    return () => {
      disposed = true
      handles.forEach((handle) => void handle.remove())
      void NativeComposer.hide({ id })
    }
  }, [id])

  const state: NativeComposerState = {
    id, text: props.value, revision: revision.current,
    placeholder: props.placeholder ?? 'Message…',
    disabled: props.disabled ?? false, submitting: props.submitting ?? false,
    running: props.running ?? false, canSteer: props.canSteer ?? false,
    hasContext: props.hasContext ?? false,
    attachments: props.attachments ?? [], skills: props.skills ?? [], suggestions: props.suggestions ?? [],
    menu: props.menu ?? [], menuTitle: props.menuTitle ?? 'Options', allowAttachments: !!props.onFiles,
  }
  // Primitive dependency: streaming responses must not send identical menu/config payloads each frame.
  const serialized = JSON.stringify(state)
  useEffect(() => {
    if (!ready) return
    if (!active) {
      void NativeComposer.hide({ id })
      return
    }
    void NativeComposer.update(JSON.parse(serialized) as NativeComposerState)
  }, [id, ready, active, serialized])

  useLayoutEffect(() => {
    const el = anchor.current
    if (!ready || !active || !el) return
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0) {
          void NativeComposer.hide({ id })
          return
        }
        const keyboardHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--keyboard-height')) || 0
        void NativeComposer.layout({ id, x: rect.x, width: rect.width, bottom: window.innerHeight - rect.bottom, keyboardOpen: keyboardHeight > 0 })
      })
    }
    const observer = new ResizeObserver(measure)
    // Ancestors may move when the tab bar, safe area or keyboard changes without resizing the spacer.
    for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) observer.observe(parent)
    const mutations = new MutationObserver(measure)
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      mutations.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
    }
  }, [id, ready, active, height])

  return <div ref={anchor} data-native-composer aria-hidden style={{ height, width: '100%' }} />
}

/** Reuses AI Elements' attachment validation, upload and duplicate-submit guard. */
export function NativePromptComposer(props: Omit<NativeChatComposerProps, 'onSubmit' | 'onFiles' | 'attachments' | 'submitting'>) {
  const attachments = usePromptInputAttachments()
  const submitting = usePromptInputSubmitting()
  const submit = usePromptInputSubmit()
  return <NativeChatComposer
    {...props}
    submitting={submitting}
    onSubmit={submit}
    onFiles={(files) => attachments.add(files)}
    attachments={attachments.files.map((file) => ({ id: file.id, title: file.filename ?? 'Attachment' }))}
    onAction={(action) => {
      if (action.startsWith('attachment:')) attachments.remove(action.slice('attachment:'.length))
      else props.onAction?.(action)
    }}
  />
}
