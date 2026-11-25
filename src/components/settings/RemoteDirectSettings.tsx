import { useEffect, useState } from 'react'
import { FormattedMessage, defineMessages, useIntl, type IntlShape } from 'react-intl'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Monitor, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { directLinkKeys, useDirectLinkStatus } from '@/lib/direct-link-queries'
import { useMachinePeers } from '@/lib/machine-peer-queries'
import { cn } from '@/lib/utils'
import type { DirectLinkStatus, DirectPeerStatus, DirectPhoneStatus, DirectRouteMode, TailscaleInfo } from '@shared/delegations'

/** Where a tailnet admin turns on MagicDNS and HTTPS certificates. */
const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns'

const MODE_LABELS = defineMessages<DirectRouteMode>({
  auto: { id: 'settings.remote.direct.mode.auto', defaultMessage: 'Auto' },
  direct: { id: 'settings.remote.direct.mode.direct', defaultMessage: 'Direct only' },
  broker: { id: 'settings.remote.direct.mode.broker', defaultMessage: 'Broker only' },
})
const MODES: DirectRouteMode[] = ['auto', 'direct', 'broker']

/**
 * Direct connections to paired machines over Tailscale: one switch for both
 * directions, this machine's tailnet address, and the route each paired
 * machine takes. Requests are sealed the same either way; this only decides
 * whether Broker carries them.
 */
export function RemoteDirectSettings() {
  const intl = useIntl()
  const queryClient = useQueryClient()
  const status = useDirectLinkStatus()
  const peers = useMachinePeers()
  const [port, setPort] = useState('')
  const data = status.data
  const savedPort = data?.port
  useEffect(() => {
    if (savedPort !== undefined) setPort(String(savedPort))
  }, [savedPort])

  const save = (next: DirectLinkStatus) => queryClient.setQueryData(directLinkKeys.status(), next)
  const update = useMutation({
    mutationFn: (input: { enabled?: boolean; port?: number; broker?: boolean }) => api.setDirectLink(input),
    onSuccess: save,
  })
  const setMode = useMutation({
    mutationFn: ({ nodeId, mode }: { nodeId: string; mode: DirectRouteMode }) => api.setDirectPeerMode(nodeId, mode),
    onSuccess: save,
  })

  // Without Broker there is only the direct route: nothing to choose per machine.
  const brokerOn = !!data && data.broker.enabled && data.broker.signedIn
  const labelOf = (nodeId: string) => peers.data?.peers.find((peer) => peer.nodeId === nodeId)?.label ?? nodeId.slice(0, 8)
  const portValue = Number(port)
  // One above it is the phone address.
  const portValid = Number.isInteger(portValue) && portValue >= 1024 && portValue <= 65_534
  const error = update.error?.message ?? setMode.error?.message ?? status.error?.message
  const title = intl.formatMessage({ id: 'settings.remote.direct.title', defaultMessage: 'Direct connections (Tailscale)' })

  return (
    <>
      {data?.broker.signedIn && (
        <section className="flex items-start justify-between gap-3 border-t border-border/40 pt-4">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">
              <FormattedMessage id="settings.remote.direct.broker.title" defaultMessage="Use Broker" />
            </h3>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.remote.direct.broker.desc"
                defaultMessage="Off: this machine stays signed in but does not connect to Broker, and reaches your other machines and phones over Tailscale only. Notifications to phones, the web app and integrations need Broker."
              />
            </p>
          </div>
          <Switch
            aria-label={intl.formatMessage({ id: 'settings.remote.direct.broker.title', defaultMessage: 'Use Broker' })}
            checked={data.broker.enabled}
            disabled={update.isPending}
            onCheckedChange={(broker) => update.mutate({ broker })}
          />
        </section>
      )}
      <section className="space-y-3 border-t border-border/40 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{title}</h3>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.remote.direct.desc"
                defaultMessage="Connect paired devices over your Tailscale network. For computer-to-computer connections, turn this on on both computers."
              />
            </p>
          </div>
          <Switch
            aria-label={title}
            checked={data?.enabled ?? false}
            disabled={update.isPending || !data}
            onCheckedChange={(enabled) => update.mutate({ enabled })}
          />
        </div>

        {data && !data.broker.enabled && !data.enabled && (
          <p className="text-xs text-status-warn">
            <FormattedMessage
              id="settings.remote.direct.broker.offHint"
              defaultMessage="Broker is off, so turn on direct connections to reach anything."
            />
          </p>
        )}

        {status.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <FormattedMessage id="settings.remote.direct.loading" defaultMessage="Loading…" />
          </div>
        )}

        {data && (
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-3 text-xs text-muted-foreground">
            <span>Tailscale</span>
            <span className={cn('min-w-0 truncate', data.tailscale.state === 'running' ? 'text-status-ok' : undefined)}>
              {tailscaleText(intl, data.tailscale)}
            </span>
            {data.enabled && (
              <>
                <span>
                  <FormattedMessage id="settings.remote.direct.address" defaultMessage="Address for other computers" />
                </span>
                {data.address
                  ? <span className="min-w-0 select-all truncate font-mono text-foreground/85">{data.address}</span>
                  : <span className="min-w-0 text-status-warn">{data.error}</span>}
              </>
            )}
          </div>
        )}

        {data?.enabled && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (portValid && portValue !== data.port) update.mutate({ port: portValue })
            }}
          >
            <label htmlFor="direct-port" className="text-xs text-muted-foreground">
              <FormattedMessage id="settings.remote.direct.port" defaultMessage="Port" />
            </label>
            <Input
              id="direct-port"
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
              className="h-8 w-24 border-border/50 font-mono"
            />
            <Button type="submit" size="sm" variant="secondary" className="h-8 gap-1.5" disabled={update.isPending || !portValid || portValue === data.port}>
              {update.isPending && update.variables?.port !== undefined && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <FormattedMessage id="settings.remote.direct.savePort" defaultMessage="Save" />
            </Button>
          </form>
        )}

        {data?.enabled && (
          <PhoneDirect phones={data.phones} />
        )}

        {data?.enabled && data.peers.length > 0 && (
          <ul className="divide-y divide-border/40 dark:divide-border/35 dark:border-border/35">
            {data.peers.map((peer) => (
              <li key={peer.nodeId} className="flex items-center gap-3 py-2">
                <Monitor aria-hidden="true" className="mt-0.5 size-3.5 self-start shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{labelOf(peer.nodeId)}</div>
                  <div className="truncate text-xs text-muted-foreground" title={peer.error}>
                    {peerDetail(intl, peer)}
                  </div>
                </div>
                <span className={cn('shrink-0 text-xs', peer.route === 'direct' ? 'text-status-ok' : 'text-muted-foreground')}>
                  {routeText(intl, peer)}
                </span>
                {brokerOn && <Select
                  value={peer.mode}
                  disabled={setMode.isPending}
                  onValueChange={(mode) => setMode.mutate({ nodeId: peer.nodeId, mode: mode as DirectRouteMode })}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={intl.formatMessage(
                      { id: 'settings.remote.direct.modeLabel', defaultMessage: 'How to reach {name}' },
                      { name: labelOf(peer.nodeId) },
                    )}
                    className="h-7 w-[124px] shrink-0 text-xs shadow-none"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODES.map((mode) => (
                      <SelectItem key={mode} value={mode} className="text-xs">{intl.formatMessage(MODE_LABELS[mode])}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>}
              </li>
            ))}
          </ul>
        )}

        {error && <div role="status" className="flex items-center gap-2 text-xs text-destructive">{error}</div>}
      </section>
    </>
  )
}

/**
 * Phones: this machine published through Tailscale Serve at an HTTPS address,
 * which paired phones learn over their encrypted channel.
 */
function PhoneDirect({ phones }: { phones: DirectPhoneStatus }) {
  const intl = useIntl()
  const title = intl.formatMessage({ id: 'settings.remote.direct.phones.title', defaultMessage: 'Address for phones' })
  return (
    <div className="space-y-2 py-3 dark:border-border/35">
      <div className="flex items-start gap-3">
        <Smartphone aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm">{title}</div>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.remote.direct.phones.desc"
              defaultMessage="Connect your phone to the same Tailscale network. Once paired, Operon on your phone uses the HTTPS address automatically."
            />
          </p>
        </div>
      </div>
      {phones.enabled && (
        <div className="space-y-1 pl-[26px] text-xs text-muted-foreground">
          {phones.address ? (
            <div className="min-w-0 select-all truncate font-mono text-foreground/85">{phones.address}</div>
          ) : phones.needsHttps ? (
            <p className="text-status-warn">
              <FormattedMessage
                id="settings.remote.direct.phones.needsHttps"
                defaultMessage="Turn on MagicDNS and HTTPS Certificates for your tailnet in the <link>Tailscale admin console</link>, then come back. Machine names become visible in the public certificate log."
                values={{
                  link: (chunks) => (
                    <a href={TAILSCALE_DNS_ADMIN_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
                      {chunks}
                    </a>
                  ),
                }}
              />
            </p>
          ) : phones.error ? (
            <p className="break-words text-status-warn">{phones.error}</p>
          ) : (
            <p>
              <FormattedMessage id="settings.remote.direct.phones.waiting" defaultMessage="Waiting for Tailscale…" />
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function tailscaleText(intl: IntlShape, info: TailscaleInfo): string {
  switch (info.state) {
    case 'running':
      return intl.formatMessage(
        { id: 'settings.remote.direct.tailscale.running', defaultMessage: 'Connected · {name}' },
        { name: info.dnsName ?? info.ipv4 ?? '' },
      )
    case 'needs_login':
      return intl.formatMessage({ id: 'settings.remote.direct.tailscale.needsLogin', defaultMessage: 'Installed, not signed in' })
    case 'stopped':
      return intl.formatMessage({ id: 'settings.remote.direct.tailscale.stopped', defaultMessage: 'Not connected' })
    default:
      return intl.formatMessage({ id: 'settings.remote.direct.tailscale.notFound', defaultMessage: 'Not installed' })
  }
}

function peerDetail(intl: IntlShape, peer: DirectPeerStatus): string {
  if (peer.mode === 'broker') return intl.formatMessage({ id: 'settings.remote.direct.peer.brokerOnly', defaultMessage: 'Always through Broker' })
  if (!peer.address) {
    return intl.formatMessage({ id: 'settings.remote.direct.peer.noAddress', defaultMessage: 'This computer has no Tailscale address for this device.' })
  }
  if (peer.error) return `${peer.address} · ${peer.error}`
  return peer.address
}

function routeText(intl: IntlShape, peer: DirectPeerStatus): string {
  switch (peer.route) {
    case 'direct':
      return intl.formatMessage({ id: 'settings.remote.direct.route.direct', defaultMessage: 'Direct' })
    case 'broker':
      return intl.formatMessage({ id: 'settings.remote.direct.route.broker', defaultMessage: 'Via Broker' })
    default:
      return intl.formatMessage({ id: 'settings.remote.direct.route.unknown', defaultMessage: 'Not used yet' })
  }
}
