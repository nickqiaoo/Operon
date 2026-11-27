import { useEffect, useRef, useState } from "react"
import { renderAsync } from "docx-preview"

// Render document styles in a separate document. Only embedded images and fonts
// are needed; linked resources, scripts, forms and nested frames stay blocked.
const frameHtml = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'"><style>body{margin:0;background:#eee} .docx-wrapper{padding:8px!important}</style></head><body></body></html>`

export default function WordPreview({ url, onError }: { url: string; onError: (failed: boolean) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [doc, setDoc] = useState<Document | null>(null)
  const [zoom, setZoom] = useState(1)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!doc || !frame.current) return
    const controller = new AbortController()
    const container = doc.createElement("div")
    doc.body.append(container)
    const element = frame.current
    let observer: ResizeObserver | undefined
    const blockLinks = (event: MouseEvent) => event.preventDefault()
    doc.addEventListener("click", blockLinks)
    async function render() {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) throw new Error()
      await renderAsync(await res.arrayBuffer(), container, container, {
        renderAltChunks: false, useBase64URL: true,
      })
      if (controller.signal.aborted) return
      const pages = Array.from(container.querySelectorAll<HTMLElement>("section.docx"))
      const width = Math.max(1, ...pages.map(page => page.offsetWidth)) + 16
      const fit = () => {
        const fitWidth = Math.min(1, element.clientWidth / width)
        container.style.zoom = `calc(${fitWidth} * var(--preview-zoom, 1))`
      }
      fit()
      observer = new ResizeObserver(fit)
      observer.observe(element)
      setReady(true)
    }
    void render().catch(() => { if (!controller.signal.aborted) onError(true) })
    return () => {
      controller.abort()
      observer?.disconnect()
      doc.removeEventListener("click", blockLinks)
      container.remove()
    }
  }, [url, doc, onError])
  useEffect(() => {
    doc?.body.style.setProperty("--preview-zoom", String(zoom))
  }, [doc, zoom])
  return <div className="flex h-full flex-col">
    {ready && <div className="flex justify-center py-1 text-xs">
      <select aria-label="Document zoom" value={zoom} onChange={event => setZoom(Number(event.target.value))}>
        <option value={1}>Fit width</option><option value={1.5}>150%</option><option value={2}>200%</option>
      </select>
    </div>}
    {!ready && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Loading document…</div>}
    <iframe ref={frame} title="Word document" sandbox="allow-same-origin" srcDoc={frameHtml}
      className={`min-h-0 w-full flex-1 border-0 ${ready ? "" : "invisible"}`}
      onLoad={() => setDoc(frame.current?.contentDocument ?? null)} />
  </div>
}
