import { useEffect, useRef, useState } from "react"
import { Document, Page, pdfjs } from "react-pdf"
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
import "react-pdf/dist/Page/TextLayer.css"
import type { PDFDocumentProxy } from "pdfjs-dist"
import { Button } from "@/components/ui/button"

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const assetBase = new URL(import.meta.env.BASE_URL + "pdf-assets/", document.baseURI).href
const options = {
  cMapUrl: assetBase + "cmaps/",
  standardFontDataUrl: assetBase + "standard_fonts/",
  wasmUrl: assetBase + "wasm/",
  iccUrl: assetBase + "iccs/",
}

export default function PdfPreview({ url, onError }: { url: string; onError: (failed: boolean) => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [page, setPage] = useState(1)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const count = pdf?.numPages ?? 0
  const [query, setQuery] = useState("")
  const [searchStatus, setSearchStatus] = useState("")
  const searchId = useRef(0)
  useEffect(() => () => { searchId.current++ }, [])

  async function findPage() {
    if (!pdf || !query.trim()) return
    const id = ++searchId.current
    const needle = query.trim().toLocaleLowerCase()
    setSearchStatus("Searching…")
    try {
      for (let step = 1; step <= count; step++) {
        const number = (page - 1 + step) % count + 1
        const current = await pdf.getPage(number)
        const { items } = await current.getTextContent()
        if (id !== searchId.current) return
        const text = items.map(item => "str" in item ? item.str : "").join(" ").toLocaleLowerCase()
        if (text.includes(needle)) {
          setPage(number)
          setSearchStatus(`Found on page ${number}`)
          return
        }
      }
      setSearchStatus("No matching pages")
    } catch {
      if (id === searchId.current) setSearchStatus("Search unavailable")
    }
  }
  const [scale, setScale] = useState(1)
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null)
  useEffect(() => {
    if (__APP_TARGET__ !== "web") return
    const controller = new AbortController()
    void fetch(url, { signal: controller.signal }).then(async res => {
      if (!res.ok) throw new Error()
      const data = await res.arrayBuffer()
      if (!controller.signal.aborted) setBytes(data)
    }).catch(() => { if (!controller.signal.aborted) onError(true) })
    return () => controller.abort()
  }, [url, onError])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(Math.max(1, el.clientWidth - 16)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return <div className="flex h-full flex-col">
    <div className="flex items-center justify-center gap-2 py-1 text-xs">
      <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
      <span>{page} / {count || "…"}</span>
      <Button variant="ghost" size="sm" disabled={page >= count} onClick={() => setPage(page + 1)}>Next</Button>
      <select aria-label="PDF zoom" value={scale} onChange={event => setScale(Number(event.target.value))}>
        <option value={1}>Fit width</option><option value={1.5}>150%</option><option value={2}>200%</option>
      </select>
    </div>
    <form className="flex flex-wrap items-center gap-2 px-2 pb-1 text-xs" onSubmit={event => {
      event.preventDefault()
      void findPage()
    }}>
      <input aria-label="Find in PDF" type="search" placeholder="Find in PDF" className="min-w-0 flex-1 rounded bg-muted px-2 py-1"
        value={query} onChange={event => { searchId.current++; setQuery(event.target.value); setSearchStatus("") }} />
      <Button type="submit" size="sm" variant="ghost" disabled={!pdf || !query.trim()}>Find next</Button>
      {searchStatus && <span role="status">{searchStatus}</span>}
    </form>
    <div ref={viewport} className="min-h-0 flex-1 overflow-auto bg-muted/20 p-2">
      <Document options={options} file={__APP_TARGET__ === "web" ? bytes : url} loading="Loading PDF…" noData="Loading PDF…"
        onLoadSuccess={setPdf} onLoadError={() => onError(true)}
        onPassword={() => onError(true)} >
        {width > 0 && <Page pageNumber={page} width={width * scale} renderAnnotationLayer={false} onRenderError={() => onError(true)} />}
      </Document>
    </div>
  </div>
}
