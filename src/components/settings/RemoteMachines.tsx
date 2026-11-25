import { useEffect, useState } from 'react'
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Check, Copy, KeyRound, Link2, Loader2, Monitor, RefreshCw, Server, Unlink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { ApiError } from '@/lib/api-client'
import { delegationKeys, useDelegationMachines } from '@/lib/delegation-queries'
import { machinePeerKeys, useMachinePairingCodeStatus, useMachinePeers } from '@/lib/machine-peer-queries'
import { useTransientFlag } from '@/hooks/useTransientFlag'
import type { MachinePairingCode, MachinePeer } from '@shared/delegations'

interface MachineRow {
  nodeId: string
  label: string
  online: boolean
  current: boolean
  peer?: MachinePeer
}

/**
 * The account's machines and this machine's pairings with them, in one list.
 * Until two machines pair, neither can reach the other; the code is shown on one
 * and typed on the other, so Broker, which relays their requests, never learns
 * the keys.
 */
export function RemoteMachines() {
  const intl = useIntl()
  const queryClient = useQueryClient()
  const machines = useDelegationMachines({ refetchInterval: 10_000 })
  const peers = useMachinePeers()
  // `server`: the code is for `operon node join` on a headless server, which also
  // signs that server in; it pairs through the same code this machine shows.
  const [shown, setShown] = useState<(MachinePairingCode & { kind: 'pair' | 'server' }) | null>(null)
  const [entering, setEntering] = useState(false)
  const [code, setCode] = useState('')
  const [justPaired, setJustPaired] = useState<MachinePeer | null>(null)
  const [copied, flashCopied, clearCopied] = useTransientFlag(2000)
  const status = useMachinePairingCodeStatus(shown !== null)
  const now = useNow(shown !== null)

  const showCode = useMutation({
    mutationFn: async (kind: 'pair' | 'server') =>
      ({ ...(await (kind === 'server' ? api.startNodeEnrollment() : api.startMachinePairing())), kind }),
    onSuccess: (data) => {
      queryClient.removeQueries({ queryKey: machinePeerKeys.code() })
      clearCopied()
      setJustPaired(null)
      setEntering(false)
      setShown(data)
    },
  })
  const join = useMutation({
    mutationFn: (value: string) => api.joinMachinePairing(value),
    onSuccess: ({ peer }) => {
      setJustPaired(peer)
      setEntering(false)
      setCode('')
      invalidatePairing(queryClient)
    },
  })
  const revoke = useMutation({
    mutationFn: (nodeId: string) => api.revokeMachinePeer(nodeId),
    onSuccess: () => invalidatePairing(queryClient),
  })

  // The other machine entered the code shown here.
  const pairedPeer = shown && status.data?.status === 'paired' ? status.data.peer : undefined
  useEffect(() => {
    if (!pairedPeer) return
    setJustPaired(pairedPeer)
    setShown(null)
    invalidatePairing(queryClient)
  }, [pairedPeer, queryClient])

  const expired = shown !== null && (status.data?.status === 'expired' || shown.expiresAt <= now)
  const cancelCode = () => {
    setShown(null)
    void api.cancelMachinePairing().catch(() => undefined)
  }
  const serverCommand = shown?.kind === 'server' ? `operon node join ${shown.code}` : undefined
  const copyCode = async () => {
    if (!shown) return
    try {
      await navigator.clipboard.writeText(serverCommand ?? shown.code)
      flashCopied()
    } catch { /* the code stays on screen to type */ }
  }

  const rows = machineRows(machines.data?.machines ?? [], peers.data?.peers ?? [])
  const labelOf = (nodeId: string): string => rows.find((row) => row.nodeId === nodeId)?.label ?? nodeId.slice(0, 8)
  // Two machines can share a name (a reinstall registers a new one); tell them apart.
  const duplicate = (row: MachineRow) => rows.some((other) => other !== row && other.label === row.label)
  const busy = shown !== null || entering
  const failure = showCode.error ?? join.error ?? revoke.error
  const error = failure ? errorText(intl, failure) : undefined

  return (
    <section className="space-y-3 border-t border-border/40 pt-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">
            <FormattedMessage id="settings.remote.machines.title" defaultMessage="Your machines" />
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.remote.machines.desc"
              defaultMessage="Machines on your account reach each other only once paired: show a code on one and enter it on the other. Broker relays their requests but cannot read or forge them. A machine paired with one of yours is paired with the rest too."
            />
          </p>
        </div>
        {!busy && (
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={showCode.isPending} onClick={() => showCode.mutate('pair')}>
              {showCode.isPending && showCode.variables === 'pair' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
              <FormattedMessage id="settings.remote.machines.showCode" defaultMessage="Show code" />
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => { setJustPaired(null); join.reset(); setEntering(true) }}>
              <Link2 className="h-3.5 w-3.5" />
              <FormattedMessage id="settings.remote.machines.enterCode" defaultMessage="Enter code" />
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" disabled={showCode.isPending} onClick={() => showCode.mutate('server')}>
              {showCode.isPending && showCode.variables === 'server' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Server className="h-3.5 w-3.5" />}
              <FormattedMessage id="settings.remote.machines.addServer" defaultMessage="Add a server" />
            </Button>
          </div>
        )}
      </div>

      {shown && (
        <div className="space-y-3 rounded-lg bg-background/50 p-4">
          <div>
            <div className="text-sm font-medium">
              {expired
                ? <FormattedMessage id="settings.remote.machines.codeExpired" defaultMessage="Pairing code expired" />
                : serverCommand
                  ? <FormattedMessage id="settings.remote.machines.serverTitle" defaultMessage="Run this on the server" />
                  : <FormattedMessage id="settings.remote.machines.codeShownTitle" defaultMessage="Enter this code on your other machine" />}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {expired
                ? <FormattedMessage id="settings.remote.machines.codeLifetime" defaultMessage="Codes last five minutes." />
                : serverCommand
                  ? <FormattedMessage
                      id="settings.remote.machines.serverDesc"
                      defaultMessage="It signs the server in to your account and pairs it with this machine. The server must be running operon (operon service install). It works once and expires in {time}."
                      values={{ time: formatRemaining(shown.expiresAt - now) }}
                    />
                  : <FormattedMessage
                      id="settings.remote.machines.codeShownDesc"
                      defaultMessage="There: Settings → Remote → Enter code. It works once and expires in {time}."
                      values={{ time: formatRemaining(shown.expiresAt - now) }}
                    />}
            </p>
          </div>
          {!expired && (serverCommand
            ? <div className="select-all break-all rounded-lg border border-border/40 bg-background/40 px-3 py-2 font-mono text-xs" aria-label={intl.formatMessage({ id: 'settings.remote.machines.serverCommandLabel', defaultMessage: 'Command to run on the server' })}>{serverCommand}</div>
            : <div className="select-all font-mono text-lg tracking-[0.2em]" aria-label={intl.formatMessage({ id: 'settings.remote.machines.codeLabel', defaultMessage: 'Pairing code' })}>{shown.code}</div>)}
          <div className="flex gap-1.5">
            {expired ? (
              <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={showCode.isPending} onClick={() => showCode.mutate(shown.kind)}>
                <RefreshCw className="h-3.5 w-3.5" />
                <FormattedMessage id="settings.remote.machines.newCode" defaultMessage="New code" />
              </Button>
            ) : (
              <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={() => void copyCode()}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied
                  ? <FormattedMessage id="settings.remote.machines.copied" defaultMessage="Copied" />
                  : <FormattedMessage id="settings.remote.machines.copy" defaultMessage="Copy" />}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={cancelCode}>
              <X className="h-3.5 w-3.5" />
              <FormattedMessage id="settings.remote.machines.cancel" defaultMessage="Cancel" />
            </Button>
          </div>
        </div>
      )}

      {entering && (
        <form
          className="space-y-3 rounded-lg bg-background/50 p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) join.mutate(code.trim())
          }}
        >
          <div>
            <div className="text-sm font-medium">
              <FormattedMessage id="settings.remote.machines.enterTitle" defaultMessage="Enter the code shown on your other machine" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              <FormattedMessage id="settings.remote.machines.enterDesc" defaultMessage="There: Settings → Remote → Show code. That machine must be online." />
            </p>
          </div>
          <Input
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            aria-label={intl.formatMessage({ id: 'settings.remote.machines.codeLabel', defaultMessage: 'Pairing code' })}
            autoComplete="off"
            spellCheck={false}
            className="h-8 border-border/50 font-mono tracking-[0.15em]"
          />
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" variant="secondary" className="h-8 gap-1.5" disabled={join.isPending || !code.trim()}>
              {join.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              <FormattedMessage id="settings.remote.machines.pair" defaultMessage="Pair" />
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => { setEntering(false); setCode(''); join.reset() }}>
              <X className="h-3.5 w-3.5" />
              <FormattedMessage id="settings.remote.machines.cancel" defaultMessage="Cancel" />
            </Button>
          </div>
        </form>
      )}

      {justPaired && (
        <div role="status" className="flex items-center gap-2 text-xs text-status-ok">
          <Check className="h-3.5 w-3.5" />
          <FormattedMessage
            id="settings.remote.machines.pairedWith"
            defaultMessage="Paired with {name}."
            values={{ name: justPaired.label || labelOf(justPaired.nodeId) }}
          />
        </div>
      )}

      {machines.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          <FormattedMessage id="settings.remote.machines.loading" defaultMessage="Loading machines…" />
        </p>
      )}
      {machines.isError && (
        <p role="status" className="text-xs text-muted-foreground">
          <FormattedMessage id="settings.remote.machines.loadFailed" defaultMessage="Could not refresh machine status." />
        </p>
      )}
      {machines.isSuccess && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          <FormattedMessage id="settings.remote.machines.empty" defaultMessage="No machines registered." />
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-border/40 rounded-lg bg-background/40 dark:divide-border/35">
          {rows.map((row) => (
            <li key={row.nodeId} className="flex items-center gap-3 px-3 py-2">
              <Monitor aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm" title={row.label}>{row.label}</div>
                <div className="truncate text-xs text-muted-foreground" title={row.peer ? intl.formatMessage(
                  { id: 'settings.remote.machines.fingerprint', defaultMessage: 'Key fingerprint {fingerprint}' },
                  { fingerprint: row.peer.fingerprint },
                ) : undefined}>
                  {describe(intl, row, labelOf)}{duplicate(row) ? ` · ${row.nodeId.slice(0, 6)}` : ''}
                </div>
              </div>
              <span className={row.online ? 'shrink-0 text-xs text-status-ok' : 'shrink-0 text-xs text-muted-foreground'}>
                {row.online
                  ? <FormattedMessage id="settings.remote.machines.online" defaultMessage="Online" />
                  : <FormattedMessage id="settings.remote.machines.offline" defaultMessage="Offline" />}
              </span>
              {row.peer ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                  aria-label={intl.formatMessage({ id: 'settings.remote.machines.unpair', defaultMessage: 'Unpair {name}' }, { name: row.label })}
                  title={intl.formatMessage({ id: 'settings.remote.machines.unpairHint', defaultMessage: 'Unpair (on all your machines)' })}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(row.nodeId)}
                >
                  <Unlink className="h-3.5 w-3.5" />
                </Button>
              ) : (
                // Keeps the status column aligned with the rows that have a button.
                <span aria-hidden="true" className="h-7 w-7 shrink-0" />
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <div role="status" className="flex items-center gap-2 text-xs text-destructive">{error}</div>}
    </section>
  )
}

/**
 * Broker's machines with this machine's trust in each, plus machines it still
 * trusts that Broker no longer lists. This machine first, then paired, then the
 * rest; online before offline.
 */
function machineRows(
  machines: Array<{ nodeId: string; label: string; online: boolean; current: boolean }>,
  peers: MachinePeer[],
): MachineRow[] {
  const trusted = new Map(peers.filter((peer) => peer.status === 'trusted').map((peer) => [peer.nodeId, peer]))
  const rows: MachineRow[] = machines.map((machine) => ({
    nodeId: machine.nodeId,
    label: machine.label || trusted.get(machine.nodeId)?.label || machine.nodeId.slice(0, 8),
    online: machine.online,
    current: machine.current,
    ...(!machine.current && trusted.has(machine.nodeId) ? { peer: trusted.get(machine.nodeId) } : {}),
  }))
  for (const peer of trusted.values()) {
    if (!rows.some((row) => row.nodeId === peer.nodeId)) {
      rows.push({ nodeId: peer.nodeId, label: peer.label || peer.nodeId.slice(0, 8), online: false, current: false, peer })
    }
  }
  const rank = (row: MachineRow) => (row.current ? 0 : row.peer ? 1 : 2)
  return rows.sort((a, b) => rank(a) - rank(b) || Number(b.online) - Number(a.online) || a.label.localeCompare(b.label))
}

function describe(intl: IntlShape, row: MachineRow, labelOf: (nodeId: string) => string): string {
  if (row.current) return intl.formatMessage({ id: 'settings.remote.machines.thisMachine', defaultMessage: 'This machine' })
  if (!row.peer) return intl.formatMessage({ id: 'settings.remote.machines.notPaired', defaultMessage: 'Not paired' })
  if (row.peer.source === 'paired') return intl.formatMessage({ id: 'settings.remote.machines.paired', defaultMessage: 'Paired' })
  return row.peer.introducedBy
    ? intl.formatMessage(
      { id: 'settings.remote.machines.pairedThrough', defaultMessage: 'Paired through {name}' },
      { name: labelOf(row.peer.introducedBy) },
    )
    : intl.formatMessage({ id: 'settings.remote.machines.pairedThroughOther', defaultMessage: 'Paired through another machine' })
}

/** The server's pairing errors in the user's language; anything else as the server put it. */
function errorText(intl: IntlShape, error: Error): string {
  switch (error instanceof ApiError ? error.code : undefined) {
    case 'pairing_not_found':
      return intl.formatMessage({
        id: 'settings.remote.machines.error.notFound',
        defaultMessage: 'No machine is showing this code. Check the code, and that the machine showing it is online.',
      })
    case 'pairing_code_invalid':
      return intl.formatMessage({
        id: 'settings.remote.machines.error.invalidCode',
        defaultMessage: 'That is not a pairing code. A code is 16 letters or digits, in groups of four.',
      })
    case 'not_signed_in':
      return intl.formatMessage({
        id: 'settings.remote.machines.error.notSignedIn',
        defaultMessage: 'Sign this machine in first.',
      })
    case 'node_unreachable':
      return intl.formatMessage({
        id: 'settings.remote.machines.error.unreachable',
        defaultMessage: 'Could not reach the machine through Broker.',
      })
    default:
      return error.message
  }
}

/** Pairing changes which machines this one can reach, so the machine lists refresh too. */
function invalidatePairing(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: machinePeerKeys.all })
  void queryClient.invalidateQueries({ queryKey: delegationKeys.all })
}

/** The current time, ticking each second while `running`. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])
  return now
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
