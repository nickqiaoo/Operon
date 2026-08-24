import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { Camera, KeyRound, Loader2, ScanLine, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { pairRemoteNode, parsePairingQr } from '@/lib/e2ee/pairing'

interface SecurePairingCardProps {
  nodeId: string
  nodeLabel: string
  onPaired: () => void
  onBack: () => void
}

export function SecurePairingCard({ nodeId, nodeLabel, onPaired, onBack }: SecurePairingCardProps) {
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<'idle' | 'submitting' | 'pending'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number | null>(null)
  const scannerRunRef = useRef(0)
  const pairingAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    pairingAbortRef.current?.abort()
    stopScanner()
  }, [])

  const submit = async (raw: string) => {
    if (status !== 'idle') return
    setError(null)
    setStatus('submitting')
    stopScanner()
    const controller = new AbortController()
    pairingAbortRef.current = controller
    try {
      const qr = parsePairingQr(raw.trim())
      await pairRemoteNode({
        qr,
        expectedNodeId: nodeId,
        deviceName: deviceLabel(),
        signal: controller.signal,
        onStatus: (next) => {
          if (next === 'pending') setStatus('pending')
        },
      })
      onPaired()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not pair this device')
      setStatus('idle')
    } finally {
      if (pairingAbortRef.current === controller) pairingAbortRef.current = null
    }
  }

  const startScanner = async () => {
    setError(null)
    const runId = ++scannerRunRef.current
    // Mount the video before requesting permission. On the first iOS prompt,
    // getUserMedia resumes outside the click event and can otherwise race the
    // React commit, leaving the live stream attached to no element.
    setScanning(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      if (scannerRunRef.current !== runId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const video = videoRef.current
      if (!video || scannerRunRef.current !== runId) {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        return
      }
      video.srcObject = stream
      await video.play()
      scanFrame()
    } catch {
      if (scannerRunRef.current !== runId) return
      stopScanner()
      setError('Camera access is unavailable. Paste the pairing code instead.')
    }
  }

  const scanFrame = () => {
    const video = videoRef.current
    if (!video || !streamRef.current) return
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context?.drawImage(video, 0, 0)
      const image = context?.getImageData(0, 0, canvas.width, canvas.height)
      if (image) {
        const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
        if (result?.data) {
          setCode(result.data)
          void submit(result.data)
          return
        }
      }
    }
    frameRef.current = requestAnimationFrame(scanFrame)
  }

  function stopScanner() {
    scannerRunRef.current += 1
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    const video = videoRef.current
    if (video) {
      video.pause()
      video.srcObject = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setScanning(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-5 rounded-xl border border-border/50 bg-muted/10 p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary"><KeyRound className="h-5 w-5" /></div>
          <div>
            <h1 className="text-sm font-medium">Securely pair this device</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Open Remote settings on {nodeLabel}, create a pairing code, then scan it here.
            </p>
          </div>
        </div>

        {scanning && (
          <div className="relative overflow-hidden rounded-lg bg-muted">
            <video ref={videoRef} muted playsInline className="aspect-square w-full object-cover" />
            <ScanLine className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow" />
            <Button size="icon" variant="secondary" className="absolute right-2 top-2 h-8 w-8" onClick={stopScanner}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        {status === 'pending' ? (
          <div className="flex items-center gap-3 rounded-lg bg-primary/5 p-4 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Approve this device on {nodeLabel} to finish pairing.
          </div>
        ) : (
          <div className="space-y-3">
            {!scanning && (
              <Button className="w-full gap-2" onClick={() => void startScanner()} disabled={status !== 'idle'}>
                <Camera className="h-4 w-4" /> Scan pairing QR code
              </Button>
            )}
            <div className="relative flex items-center py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              <span className="h-px flex-1 bg-border/50" /><span className="px-3">or paste code</span><span className="h-px flex-1 bg-border/50" />
            </div>
            <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste pairing code" />
            <Button variant="secondary" className="w-full" disabled={!code.trim() || status !== 'idle'} onClick={() => void submit(code)}>
              {status === 'submitting' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Pair device
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button variant="ghost" size="sm" onClick={() => {
          pairingAbortRef.current?.abort()
          onBack()
        }}>Choose another machine</Button>
      </div>
    </div>
  )
}

function deviceLabel(): string {
  const platform = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    ? 'iPhone or iPad'
    : /Android/i.test(navigator.userAgent) ? 'Android device' : 'Web browser'
  return `${platform} · ${navigator.platform || 'Operon'}`
}
