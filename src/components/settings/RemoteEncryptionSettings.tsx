import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Copy, KeyRound, Loader2, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { MobilePairingSummary } from '@/types/mobile'
import type { RemotePairingQrPayload } from '@shared/e2ee/protocol'

interface PairingSession {
  payload: RemotePairingQrPayload
  imageUrl: string
}

export function RemoteEncryptionSettings() {
  const [devices, setDevices] = useState<MobilePairingSummary[]>([])
  const [session, setSession] = useState<PairingSession | null>(null)
  const [pairStatus, setPairStatus] = useState<'waiting' | 'pending' | 'expired'>('waiting')
  const [pendingDevice, setPendingDevice] = useState<MobilePairingSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDevices = useCallback(async () => {
    const result = await api.remoteE2eeDevices()
    setDevices(result.devices.filter((device) => device.status === 'confirmed'))
  }, [])

  useEffect(() => { void loadDevices().catch(() => undefined) }, [loadDevices])

  useEffect(() => {
    if (!session) return
    const poll = async () => {
      try {
        const status = await api.remoteE2eePairSession(session.payload.pairingId)
        setPendingDevice(status.pairing ?? null)
        if (status.status === 'waiting' || status.status === 'pending' || status.status === 'expired') {
          setPairStatus(status.status)
        } else if (status.status === 'rejected') {
          setPairStatus('expired')
        }
        if (status.status === 'confirmed') {
          setSession(null)
          await loadDevices()
        }
      } catch {
        // A transient local poll failure should not discard the QR secret.
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1_000)
    return () => window.clearInterval(timer)
  }, [session, loadDevices])

  const startPairing = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = await api.remoteE2eePairStart()
      const imageUrl = await QRCode.toDataURL(JSON.stringify(payload), { margin: 1, width: 260 })
      setPairStatus('waiting')
      setPendingDevice(null)
      setCopied(false)
      setSession({ payload, imageUrl })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create a pairing code')
    } finally {
      setBusy(false)
    }
  }

  const approve = async () => {
    if (!session) return
    setBusy(true)
    try {
      await api.remoteE2eePairApprove(session.payload.pairingId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not approve this device')
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    if (!session) return
    await api.remoteE2eePairReject(session.payload.pairingId).catch(() => undefined)
    setCopied(false)
    setSession(null)
  }

  const copyPairingCode = async () => {
    if (!session) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(session.payload))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      setError('Could not copy the pairing code')
    }
  }

  const revoke = async (device: MobilePairingSummary) => {
    await api.remoteE2eeRevokeDevice(device.id)
    await loadDevices()
  }

  return (
    <section className="space-y-3 border-t border-border/40 pt-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-500" />
        <div className="flex-1">
          <div className="text-sm font-medium">End-to-end encryption</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Remote request and response content is encrypted between this machine and each approved device.
          </p>
        </div>
        <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={busy || session !== null} onClick={() => void startPairing()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
          Pair device
        </Button>
      </div>

      {session && (
        <div className="grid gap-4 rounded-lg bg-background/50 p-4 sm:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            <img src={session.imageUrl} alt="Secure pairing QR code" className="h-[220px] w-[220px] rounded-md" />
            <Button
              size="sm"
              variant="secondary"
              className="w-full gap-1.5"
              disabled={pairStatus !== 'waiting'}
              onClick={() => void copyPairingCode()}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy pairing code'}
            </Button>
          </div>
          <div className="flex min-w-0 flex-col justify-center gap-3">
            <div>
              <div className="text-sm font-medium">
                {pairStatus === 'pending' ? 'Approve this device' : pairStatus === 'expired' ? 'Pairing code expired' : 'Scan with your device'}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {pairStatus === 'pending'
                  ? `Confirm only if this is the device you are holding: ${pendingDevice?.mobileLabel ?? 'Unknown device'}.`
                  : 'The code contains a one-time secret that the Broker cannot read.'}
              </p>
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {pendingDevice?.mobileFingerprint ?? session.payload.nodeFingerprint}
            </div>
            <div className="flex gap-2">
              {pairStatus === 'pending' ? (
                <Button size="sm" className="h-8 gap-1.5" disabled={busy || pendingDevice === null} onClick={() => void approve()}>
                  <Check className="h-3.5 w-3.5" /> Approve
                </Button>
              ) : pairStatus === 'expired' ? (
                <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => void startPairing()}>
                  <RefreshCw className="h-3.5 w-3.5" /> New code
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => void reject()}>
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {devices.length > 0 && (
        <div className="space-y-1.5">
          {devices.map((device) => (
            <div key={device.id} className="flex items-center gap-3 rounded-lg bg-background/40 px-3 py-2.5">
              <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{device.mobileLabel || 'Approved device'}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{device.mobileFingerprint}</div>
              </div>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" aria-label="Revoke device" onClick={() => void revoke(device)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  )
}
