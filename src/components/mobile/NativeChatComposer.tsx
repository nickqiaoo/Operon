import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNativeShellOverlayCount } from '@/hooks/useNativeShellOverlay'
import { usePageVisible } from '@/lib/page-visibility'
import { NativeComposer, composerThumbnail, type NativeComposerState, type ComposerMenuItem, type ComposerSuggestion, type ComposerToken } from '@/lib/native-composer'
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
  /** The screen may refuse this send and keep the draft: leave clearing the field to it. */
  keepTextOnSend?: boolean
}

/** UIKit's one-line capsule at the default text size (NativeComposerView.compactHeight). */
const DEFAULT_RESTING_HEIGHT = 46
/** The smallest height UIKit has reported: the capsule, at whatever text size this device uses. */
let restingHeight: number | undefined

/** The DOM keeps a spacer; UIKit owns editing, glass, hit testing and keyboard animation. */
export function NativeChatComposer(props: NativeChatComposerProps) {
  const id = useId()
  const anchor = useRef<HTMLDivElement>(null)
  const revision = useRef(0)
  const latest = useRef(props)
  latest.current = props
  // UIKit's first report lands a bridge round trip after mount. Starting at any other height
  // moves the transcript pinned above this spacer each time a screen mounts (a tab switch).
  const [height, setHeight] = useState(() => restingHeight ?? DEFAULT_RESTING_HEIGHT)
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
        if (event.id !== id || disposed) return
        restingHeight = Math.min(restingHeight ?? event.height, event.height)
        setHeight(event.height)
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
    keepTextOnSend: props.keepTextOnSend ?? false,
  }
  // Primitive dependency: streaming responses must not send identical menu/config payloads each frame.
  const serialized = JSON.stringify(state)
  const serializedRef = useRef(serialized)
  serializedRef.current = serialized
  // Whether UIKit holds this owner's editor in the view tree; see `measure` below.
  const attached = useRef(false)
  useEffect(() => {
    if (!ready) return
    if (!active) {
      attached.current = false
      void NativeComposer.hide({ id })
      return
    }
    void NativeComposer.update(JSON.parse(serialized) as NativeComposerState)
  }, [id, ready, active, serialized])

  useLayoutEffect(() => {
    const el = anchor.current
    if (!ready || !active || !el) return
    let frame = 0
    // The spacer's height transition resizes it every frame, but its bottom edge
    // (all UIKit reads) stays put. Re-sending the same anchor would make UIKit
    // re-lay out without animation in the middle of its own grow animation.
    let sent = ''
    // UIKit ignores a `layout` for any owner but the one its last `update`
    // configured, and a `hide` takes the editor out of the tree, which only
    // `update` puts back.
    // So the first anchor after mount, and after any hide, goes out behind an
    // `update` of its own instead of trusting the update effect to have run
    // first: this frame can beat React's passive effects, and then the one
    // layout UIKit gets is dropped (another chat still owns the editor) and the
    // composer stays hidden for good — `sent` dedupes every later measure.
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0) {
          sent = ''
          attached.current = false
          void NativeComposer.hide({ id })
          return
        }
        const keyboardHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--keyboard-height')) || 0
        const anchor = { id, x: rect.x, width: rect.width, bottom: window.innerHeight - rect.bottom, keyboardOpen: keyboardHeight > 0 }
        const key = JSON.stringify(anchor)
        if (key === sent) return
        sent = key
        if (attached.current) {
          void NativeComposer.layout(anchor)
          return
        }
        attached.current = true
        void NativeComposer.update(JSON.parse(serializedRef.current) as NativeComposerState)
          .then(() => NativeComposer.layout(anchor))
          .catch(console.error)
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

  // UIKit grows the editor over 0.2s ease-out when a new line is typed
  // (NativeComposerView.textViewDidChange). The spacer follows on the same curve,
  // so the transcript pinned above it slides up with the glass. Snapping here
  // moved the messages a few frames after the glass, which read as a shake.
  // `ease-out` is spelled out: Tailwind's differs from UIKit's .curveEaseOut.
  return (
    <div
      ref={anchor}
      data-native-composer
      aria-hidden
      className="transition-[height] duration-200 ease-[cubic-bezier(0,0,0.58,1)] motion-reduce:transition-none"
      style={{ height, width: '100%' }}
    />
  )
}

/** Reuses AI Elements' attachment validation, upload and duplicate-submit guard. */
export function NativePromptComposer(props: Omit<NativeChatComposerProps, 'onSubmit' | 'onFiles' | 'attachments' | 'submitting'>) {
  const attachments = usePromptInputAttachments()
  const submitting = usePromptInputSubmitting()
  const submit = usePromptInputSubmit()
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const imageKey = attachments.files.filter((file) => file.mediaType?.startsWith('image/')).map((file) => `${file.id}\n${file.url}`).join('\n\n')
  useEffect(() => {
    let cancelled = false
    const images = imageKey ? imageKey.split('\n\n').map((entry) => entry.split('\n') as [string, string]) : []
    void Promise.all(images.map(async ([id, url]) => [id, await composerThumbnail(url)] as const)).then((entries) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const [id, thumb] of entries) if (thumb) next[id] = thumb
      setThumbs(next)
    })
    return () => { cancelled = true }
  }, [imageKey])
  return <NativeChatComposer
    {...props}
    submitting={submitting}
    onSubmit={submit}
    onFiles={(files) => attachments.add(files)}
    attachments={attachments.files.map((file) => ({ id: file.id, title: file.filename ?? 'Attachment', ...(thumbs[file.id] ? { thumbnail: thumbs[file.id] } : {}) }))}
    onAction={(action) => {
      if (action.startsWith('attachment:')) attachments.remove(action.slice('attachment:'.length))
      else props.onAction?.(action)
    }}
  />
}
