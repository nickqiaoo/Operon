import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FormattedMessage, defineMessages, useIntl } from 'react-intl'
import { Switch } from '@/components/ui/switch'
import { codingAgentName } from '@/components/assistant/CodingAgentCard'
import { api } from '@/lib/api'
import { delegationKeys, useDelegationSettings } from '@/lib/delegation-queries'
import type { IncomingDelegation } from '@shared/delegations'

const STATUS_LABELS = defineMessages<IncomingDelegation['status']>({
  queued: { id: 'settings.remote.delegation.status.queued', defaultMessage: 'Queued' },
  running: { id: 'settings.remote.delegation.status.running', defaultMessage: 'Running' },
  completed: { id: 'settings.remote.delegation.status.completed', defaultMessage: 'Done' },
  cancelled: { id: 'settings.remote.delegation.status.cancelled', defaultMessage: 'Stopped' },
  failed: { id: 'settings.remote.delegation.status.failed', defaultMessage: 'Failed' },
  interrupted: { id: 'settings.remote.delegation.status.interrupted', defaultMessage: 'Interrupted' },
  idle: { id: 'settings.remote.delegation.status.idle', defaultMessage: 'Idle' },
})

/** Whether other machines of the account may run external agents here, and which recently did. */
export function RemoteDelegationSettings() {
  const intl = useIntl()
  const queryClient = useQueryClient()
  const settings = useDelegationSettings()
  const update = useMutation({
    mutationFn: api.setDelegationSettings,
    onSuccess: (data) => queryClient.setQueryData(delegationKeys.settings(), data),
  })
  const error = update.error?.message ?? settings.error?.message

  return (
    <section className="space-y-3 border-t border-border/40 pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            <FormattedMessage id="settings.remote.delegation.title" defaultMessage="Run agents for other machines" />
          </h3>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.remote.delegation.desc"
              defaultMessage="Your other paired machines can open this machine's workspaces — files, git, terminal and conversations — and start external agents here. Those agents' conversations live on this machine."
            />
          </p>
        </div>
        <Switch aria-label={intl.formatMessage({ id: 'settings.remote.delegation.title', defaultMessage: 'Run agents for other machines' })} checked={settings.data?.enabled ?? false}
          disabled={update.isPending || !settings.data} onCheckedChange={(enabled) => update.mutate(enabled)} />
      </div>
      {!!settings.data?.recent.length && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">
            <FormattedMessage id="settings.remote.delegation.recent" defaultMessage="Recent" />
          </h4>
          <ul className="divide-y divide-border/40 rounded-lg border border-border/40 bg-background/40">
            {settings.data.recent.map((item) => (
              <li key={item.childChatId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">{item.description}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {codingAgentName(item.providerId)}{item.workspace ? ` · ${item.workspace}` : ''}{' · '}
                    <FormattedMessage
                      id="settings.remote.delegation.from"
                      defaultMessage="From {name}"
                      values={{ name: item.sourceLabel || item.sourceNodeId }}
                    />
                  </p>
                </div>
                <span className={item.status === 'running' || item.status === 'queued' ? 'shrink-0 text-xs text-status-ok'
                  : item.status === 'failed' ? 'shrink-0 text-xs text-status-error' : 'shrink-0 text-xs text-muted-foreground'}>
                  {intl.formatMessage(STATUS_LABELS[item.status])}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <div role="status" className="flex items-center gap-2 text-xs text-destructive">{error}</div>}
    </section>
  )
}
