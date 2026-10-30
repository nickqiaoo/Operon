import { useEffect, useId, type RefObject } from 'react'
import { NativeComposer, hasNativeComposer } from '@/lib/native-composer'
import { usePageVisible } from '@/lib/page-visibility'
import { useIsMobile } from './useIsMobile'
import { useNativeShellOverlayCount } from './useNativeShellOverlay'

/** Keep the existing web button as the layout anchor and click handler. */
export function useNativeScrollButton(ref: RefObject<HTMLButtonElement | null>, visible: boolean) {
  const id = useId()
  const mobile = useIsMobile()
  const pageVisible = usePageVisible()
  const overlays = useNativeShellOverlayCount()
  const native = mobile && hasNativeComposer()
  const active = native && visible && pageVisible && overlays === 0

  useEffect(() => {
    if (!native) return
    const handle = NativeComposer.addListener('scrollToBottom', (event) => {
      if (event.id === id) ref.current?.click()
    })
    return () => { void handle.then((listener) => listener.remove()) }
  }, [native, id, ref])

  useEffect(() => {
    if (!native) return
    const hide = () => { void NativeComposer.setScrollButton({ id, visible: false }) }
    const button = ref.current
    if (!active || !button) { hide(); return }
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = button.getBoundingClientRect()
        void NativeComposer.setScrollButton({ id, visible: rect.width > 0, x: rect.x, y: rect.y, size: rect.width })
      })
    }
    const resize = new ResizeObserver(measure)
    const mutation = new MutationObserver(measure)
    for (let el: HTMLElement | null = button; el; el = el.parentElement) {
      resize.observe(el)
      mutation.observe(el, { attributes: true, attributeFilter: ['style', 'class'] })
    }
    window.addEventListener('resize', measure)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
      window.removeEventListener('resize', measure)
      hide()
    }
  }, [native, active, id, ref])
  return native
}
