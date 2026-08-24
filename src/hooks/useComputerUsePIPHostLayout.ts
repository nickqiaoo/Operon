import { useLayoutEffect } from 'react'

function activeHostElement(hostSessionID: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-computer-use-pip-host]'))
    .find((element) => element.dataset.computerUsePipHost === hostSessionID)
}

/**
 * Codex lets the renderer own PiP placement: the active conversation publishes
 * its current rectangle and the native host anchors inside it.
 */
export function useComputerUsePIPHostLayout(hostSessionID: string | undefined): void {
  useLayoutEffect(() => {
    const api = window.electronAPI?.computerUsePIP
    if (!api) return
    if (!hostSessionID) {
      api.setHostLayout({
        visible: false,
        anchorRect: { x: 0, y: 0, width: 0, height: 0 },
      })
      return
    }

    let observer: ResizeObserver | undefined
    let element: HTMLElement | undefined
    const publish = () => {
      if (!element?.isConnected) return
      const rect = element.getBoundingClientRect()
      api.setHostLayout({
        hostSessionID,
        visible: rect.width > 0 && rect.height > 0,
        anchorRect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
      })
    }
    const attach = () => {
      element = activeHostElement(hostSessionID)
      if (!element) return
      observer = new ResizeObserver(publish)
      observer.observe(element)
      publish()
    }

    const frame = requestAnimationFrame(attach)
    window.addEventListener('resize', publish)
    document.addEventListener('transitionend', publish, true)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', publish)
      document.removeEventListener('transitionend', publish, true)
      api.setHostLayout({
        hostSessionID,
        visible: false,
        anchorRect: { x: 0, y: 0, width: 0, height: 0 },
      })
    }
  }, [hostSessionID])
}
