import { useCallback, useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import QRCode from 'qrcode'
import { Check, Copy, KeyRound, Loader2, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { MobilePairingSummary } from '@/types/mobile'
import type { RemotePairingQrPayload } from '@shared/e2ee/protocol'
import { useTransientFlag } from '@/hooks/useTransientFlag'

interface PairingSession {
  payload: RemotePairingQrPayload
  imageUrl: string
}

export function RemoteEncryptionSettings() {
  const intl = useIntl()
  const [devices, setDevices] = useState<MobilePairingSummary[]>([])
  const [session, setSession] = useState<PairingSession | null>(null)
  const [pairStatus, setPairStatus] = useState<'waiting' | 'pending' | 'expired'>('waiting')
  const [pendingDevice, setPendingDevice] = useState<MobilePairingSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, flashCopied, clearCopied] = useTransientFlag(2000)
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
      clearCopied()
      setSession({ payload, imageUrl })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : intl.formatMessage({ id: 'settings.remote.devices.error.createCode', defaultMessage: 'Could not create a pairing code' }))
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
      setError(cause instanceof Error ? cause.message : intl.formatMessage({ id: 'settings.remote.devices.error.approve', defaultMessage: 'Could not approve this device' }))
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    if (!session) return
    await api.remoteE2eePairReject(session.payload.pairingId).catch(() => undefined)
    clearCopied()
    setSession(null)
  }

  const copyPairingCode = async () => {
    if (!session) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(session.payload))
      flashCopied()
    } catch {
      setError(intl.formatMessage({ id: 'settings.remote.devices.error.copy', defaultMessage: 'Could not copy the pairing code' }))
    }
  }

  const revoke = async (device: MobilePairingSummary) => {
    await api.remoteE2eeRevokeDevice(device.id)
    await loadDevices()
  }

  return (
    <section className="space-y-3 border-t border-border/40 pt-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            <FormattedMessage id="settings.remote.devices.title" defaultMessage="Phones and browsers" />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.remote.devices.desc"
              defaultMessage="Devices you pair here can reach this machine through Remote. Their requests and responses are end-to-end encrypted between this machine and each approved device."
            />
          </p>
        </div>
        <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={busy || session !== null} onClick={() => void startPairing()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
          <FormattedMessage id="settings.remote.devices.pair" defaultMessage="Pair device" />
        </Button>
      </div>

      {session && (
        <div className="grid gap-4 py-4 sm:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            <img src={session.imageUrl} alt={intl.formatMessage({ id: 'settings.remote.devices.qrAlt', defaultMessage: 'Secure pairing QR code' })} className="h-[220px] w-[220px] rounded-md" />
            <Button
              size="sm"
              variant="secondary"
              className="w-full gap-1.5"
              disabled={pairStatus !== 'waiting'}
              onClick={() => void copyPairingCode()}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied
                ? <FormattedMessage id="settings.remote.devices.copied" defaultMessage="Copied" />
                : <FormattedMessage id="settings.remote.devices.copyCode" defaultMessage="Copy pairing code" />}
            </Button>
          </div>
          <div className="flex min-w-0 flex-col justify-center gap-3">
            <div>
              <div className="text-sm font-medium">
                {pairStatus === 'pending'
                  ? <FormattedMessage id="settings.remote.devices.approveTitle" defaultMessage="Approve this device" />
                  : pairStatus === 'expired'
                    ? <FormattedMessage id="settings.remote.devices.codeExpired" defaultMessage="Pairing code expired" />
                    : <FormattedMessage id="settings.remote.devices.scanTitle" defaultMessage="Scan with your device" />}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {pairStatus === 'pending'
                  ? <FormattedMessage
                      id="settings.remote.devices.approveDesc"
                      defaultMessage="Confirm only if this is the device you are holding: {name}."
                      values={{ name: pendingDevice?.mobileLabel ?? intl.formatMessage({ id: 'settings.remote.devices.unknown', defaultMessage: 'Unknown device' }) }}
                    />
                  : <FormattedMessage id="settings.remote.devices.scanDesc" defaultMessage="The code contains a one-time secret that the Broker cannot read." />}
              </p>
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {pendingDevice?.mobileFingerprint ?? session.payload.nodeFingerprint}
            </div>
            <div className="flex gap-2">
              {pairStatus === 'pending' ? (
                <Button size="sm" className="h-8 gap-1.5" disabled={busy || pendingDevice === null} onClick={() => void approve()}>
                  <Check className="h-3.5 w-3.5" />
                  <FormattedMessage id="settings.remote.devices.approve" defaultMessage="Approve" />
                </Button>
              ) : pairStatus === 'expired' ? (
                <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => void startPairing()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  <FormattedMessage id="settings.remote.devices.newCode" defaultMessage="New code" />
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => void reject()}>
                <X className="h-3.5 w-3.5" />
                <FormattedMessage id="settings.remote.devices.cancel" defaultMessage="Cancel" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {devices.length > 0 && (
        <div className="space-y-1.5">
          {devices.map((device) => (
            <div key={device.id} className="flex items-center gap-3 border-b border-border/40 py-2.5 last:border-b-0">
              <ShieldCheck className="h-4 w-4 shrink-0 text-status-ok" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{device.mobileLabel || intl.formatMessage({ id: 'settings.remote.devices.approvedDevice', defaultMessage: 'Approved device' })}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{device.mobileFingerprint}</div>
              </div>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" aria-label={intl.formatMessage({ id: 'settings.remote.devices.revoke', defaultMessage: 'Revoke device' })} onClick={() => void revoke(device)}>
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
