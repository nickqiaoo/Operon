import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useChatApi, useChatNodeId } from "@/lib/chat-api-context"
import type { filePreviewKind } from "@/lib/file-preview"
import { basename } from "@/lib/workspace-files"

const WordPreview = lazy(() => import("./WordPreview"))
const PdfPreview = lazy(() => import("./PdfPreview"))
type AssetKind = Exclude<ReturnType<typeof filePreviewKind>, "text" | "image">

export default function AssetPreview({ path, kind, active }: { path: string; kind: AssetKind; active: boolean }) {
  const api = useChatApi()
  const node = useChatNodeId()
  const [url, setUrl] = useState("")
  const [failed, setFailed] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (!active) video.current?.pause()
  }, [active])
  const downloadRequest = useRef<AbortController | null>(null)
  useEffect(() => {
    let current = true
    api.getFileUrl(path).then(value => { if (current) setUrl(value) })
      .catch(() => { if (current) setFailed(true) })
    return () => {
      current = false
      downloadRequest.current?.abort()
    }
  }, [api, path])

  async function download() {
    const controller = new AbortController()
    downloadRequest.current = controller
    setDownloading(true)
    setDownloadError(false)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error()
      const objectUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement("a")
      link.href = objectUrl
      link.download = basename(path)
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000)
    } catch {
      if (!controller.signal.aborted) setDownloadError(true)
    } finally {
      if (!controller.signal.aborted) setDownloading(false)
    }
  }

  // Broker requests require authenticated fetch and relay the entire response.
  const canStreamVideo = __APP_TARGET__ !== "web" && !node
  if (failed || kind === "unsupported" || (kind === "video" && !canStreamVideo)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{downloadError ? "Download failed" : failed ? "Unable to preview this file" : "Preview unavailable"}</p>
        <Button variant="secondary" size="sm" disabled={!url || downloading} onClick={download}>
          {downloading ? "Downloading…" : "Download"}
        </Button>
      </div>
    )
  }
  const loading = <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading preview…</div>
  if (!url) return loading
  return (
    <Suspense fallback={loading}>
      {kind === "video" ? (
        <div className="flex h-full items-center justify-center">
          <video ref={video} className="max-h-full max-w-full" controls playsInline preload="metadata" src={url} onError={() => setFailed(true)} />
        </div>
      ) : kind === "docx" ? (
        <WordPreview url={url} onError={setFailed} />
      ) : (
        <PdfPreview url={url} onError={setFailed} />
      )}
    </Suspense>
  )
}
