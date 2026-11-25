import { defineMessages, useIntl, type IntlShape } from 'react-intl'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import type { CodexAccountsView } from '@operon/agent-runtime/codex'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { openExternalUrl } from '@/lib/open-external'
import { aiUsageKeys } from '@/lib/chat-queries'
import { SettingsRow, SettingsSection } from './SettingsSection'

type Account = CodexAccountsView['accounts'][number]
type WorkspaceSelection = { accountId: string; workspaceId: string }
const accountsKey = ['settings', 'codex-accounts'] as const

const labels = defineMessages({
  workspaceUnknown: { id: 'settings.codexAccounts.workspaceUnknown', defaultMessage: 'Workspace {id}' },
  personal: { id: 'settings.codexAccounts.personal', defaultMessage: 'Personal' },
  workspace: { id: 'settings.codexAccounts.workspace', defaultMessage: 'Workspace' },
  title: { id: 'settings.codexAccounts.title', defaultMessage: 'Accounts' },
  reloadWorkspaces: { id: 'settings.codexAccounts.reloadWorkspaces', defaultMessage: 'Reload workspaces' },
  refresh: { id: 'settings.codexAccounts.refresh', defaultMessage: 'Refresh account usage' },
  add: { id: 'settings.codexAccounts.add', defaultMessage: 'Add account' },
  loading: { id: 'settings.codexAccounts.loading', defaultMessage: 'Loading accounts…' },
  defaultAccount: { id: 'settings.codexAccounts.defaultAccount', defaultMessage: 'Default Codex account' },
  account: { id: 'settings.codexAccounts.account', defaultMessage: 'Codex account' },
  signedOut: { id: 'settings.codexAccounts.signedOut', defaultMessage: 'Signed out' },
  signIn: { id: 'settings.codexAccounts.signIn', defaultMessage: 'Sign in' },
  current: { id: 'settings.codexAccounts.current', defaultMessage: 'Current' },
  use: { id: 'settings.codexAccounts.use', defaultMessage: 'Use account' },
  options: { id: 'settings.codexAccounts.options', defaultMessage: 'Account options' },
  remove: { id: 'settings.codexAccounts.remove', defaultMessage: 'Remove from rotation' },
  chatgpt: { id: 'settings.codexAccounts.chatgpt', defaultMessage: 'Sign in with ChatGPT' },
  waiting: { id: 'settings.codexAccounts.waiting', defaultMessage: 'Waiting for sign-in…' },
  code: { id: 'settings.codexAccounts.code', defaultMessage: 'Enter this code:' },
  reopen: { id: 'settings.codexAccounts.reopen', defaultMessage: 'Open browser again' },
  automatic: { id: 'settings.codexAccounts.automatic', defaultMessage: 'Switch workspaces and accounts when usage runs out' },
  description: { id: 'settings.codexAccounts.description', defaultMessage: 'Try other workspaces on this account before switching accounts.' },
  switching: { id: 'settings.codexAccounts.switching', defaultMessage: 'Switching…' },
  updating: { id: 'settings.codexAccounts.updating', defaultMessage: 'Updating accounts…' },
  weekly: { id: 'settings.codexAccounts.weekly', defaultMessage: 'Weekly' },
  fiveHours: { id: 'settings.codexAccounts.fiveHours', defaultMessage: '5h' },
  minutes: { id: 'settings.codexAccounts.minutes', defaultMessage: '{minutes}m' },
  usage: { id: 'settings.codexAccounts.usage', defaultMessage: 'Usage' },
  left: { id: 'settings.codexAccounts.left', defaultMessage: '{window} · {percent} left' },
  spent: { id: 'settings.codexAccounts.spent', defaultMessage: '{window} limit reached' },
  reset: { id: 'settings.codexAccounts.reset', defaultMessage: '{window} limit reached · Resets {time}' },
  switched: { id: 'settings.codexAccounts.switched', defaultMessage: 'Switched to {account} after reaching the {limit}.' },
  next: { id: 'settings.codexAccounts.next', defaultMessage: 'the next available account' },
  unavailable: { id: 'settings.codexAccounts.unavailable', defaultMessage: 'No Codex account is currently available.' },
  nextReset: { id: 'settings.codexAccounts.nextReset', defaultMessage: 'No Codex account is currently available. Next reset: {time}' },
  unknown: { id: 'settings.codexAccounts.unknown', defaultMessage: 'Unknown Codex account' },
  signInFirst: { id: 'settings.codexAccounts.signInFirst', defaultMessage: 'Sign in to this account first.' },
  switchFailed: { id: 'settings.codexAccounts.switchFailed', defaultMessage: 'Could not switch accounts.' },
  signedOutFirst: { id: 'settings.codexAccounts.signedOutFirst', defaultMessage: 'Select a signed-out account to sign in again.' },
  failed: { id: 'settings.codexAccounts.failed', defaultMessage: 'Sign-in failed.' },
  incomplete: { id: 'settings.codexAccounts.incomplete', defaultMessage: 'Sign-in was not completed.' },
  duplicate: { id: 'settings.codexAccounts.duplicate', defaultMessage: 'This account is already added.' },
  noUrl: { id: 'settings.codexAccounts.noUrl', defaultMessage: 'Codex did not return a sign-in URL.' },
  selectFirst: { id: 'settings.codexAccounts.selectFirst', defaultMessage: 'Select another account before removing this account.' },
  timeout: { id: 'settings.codexAccounts.timeout', defaultMessage: 'Login timed out' },
  cancel: { id: 'common.cancel', defaultMessage: 'Cancel' },
})

function windowLabel(intl: IntlShape, minutes?: number | null) {
  if (minutes === 300) return intl.formatMessage(labels.fiveHours)
  if (minutes === 10080) return intl.formatMessage(labels.weekly)
  return minutes ? intl.formatMessage(labels.minutes, { minutes }) : intl.formatMessage(labels.usage)
}

function resetTime(intl: IntlShape, date: number) {
  return intl.formatDate(date, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function localizeError(intl: IntlShape, text: string) {
  const label = Object.values(labels).find(m => m.defaultMessage === text)
  return label ? intl.formatMessage(label) : text
}

function status(intl: IntlShape, data: CodexAccountsView) {
  const notice = data.notice
  if (notice?.type === 'switched') return intl.formatMessage(labels.switched, {
    account: notice.email ?? intl.formatMessage(labels.next), limit: windowLabel(intl, notice.minutes),
  })
  if (notice?.type === 'unavailable') return notice.resetAt
    ? intl.formatMessage(labels.nextReset, { time: resetTime(intl, notice.resetAt) })
    : intl.formatMessage(labels.unavailable)
  return data.message && localizeError(intl, data.message)
}

function usage(intl: IntlShape, account: Account) {
  const windows = [account.quota?.primary, account.quota?.secondary].flatMap(w => w ? [w] : [])
  return windows.map(w => {
    const window = windowLabel(intl, w.windowDurationMins)
    if (w.usedPercent < 100) return intl.formatMessage(labels.left, {
      window, percent: intl.formatNumber(Math.ceil(100 - w.usedPercent) / 100, { style: 'percent' }),
    })
    return w.resetsAt
      ? intl.formatMessage(labels.reset, { window, time: resetTime(intl, w.resetsAt * 1000) })
      : intl.formatMessage(labels.spent, { window })
  }).join(' / ')
}

export function CodexAccountsSettings() {
  const intl = useIntl()
  const t = intl.formatMessage
  const client = useQueryClient()
  const query = useQuery({
    queryKey: accountsKey,
    queryFn: () => api.codexAccounts(),
    refetchInterval: q => q.state.data?.login ? 1500 : 60_000,
    retry: false,
  })
  const action = useMutation({
    mutationFn: (operation: WorkspaceSelection | (() => Promise<unknown>)) =>
      typeof operation === 'function' ? operation() : api.codexWorkspaceSelect(operation.accountId, operation.workspaceId),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: accountsKey }),
        client.invalidateQueries({ queryKey: aiUsageKeys.codex() }),
      ])
    },
  })
  const data = query.data
  const login = data?.login
  const busy = action.isPending
  const switching = busy && typeof action.variables === 'object' ? action.variables : undefined
  const signedIn = data?.accounts.filter(a => a.signedIn) ?? []
  const signIn = (id?: string) => action.mutate(async () => {
    const result = await api.codexAccountLogin(!window.electronAPI, id)
    openExternalUrl(result.url)
  })
  const refresh = () => action.mutate(async () => client.setQueryData(accountsKey, await api.codexAccounts(true)))
  const error = action.error ?? query.error
  return (
    <SettingsSection title={t(labels.title)} action={
      <>
        <Button variant="ghost" size="icon" aria-label={t(labels.refresh)} disabled={busy}
          onClick={refresh}>
          <RefreshCw className="size-4" />
        </Button>
        {signedIn.length > 0 && <Button variant="outline" size="sm" disabled={busy || !!login} onClick={() => signIn()}>
          <Plus className="size-4" /> {t(labels.add)}
        </Button>}
      </>
    }>
      {query.isLoading && <p className="text-sm text-muted-foreground">{t(labels.loading)}</p>}
      {data?.accounts.filter(a => a.signedIn || a.id !== 'default' || signedIn.length > 0).map(a => (
        <SettingsRow key={a.id} title={a.email ?? (a.id === 'default' ? t(labels.defaultAccount) : t(labels.account))}
          description={<>
            {[a.signedIn ? a.plan : t(labels.signedOut), usage(intl, a)].filter(Boolean).join(' · ')}
            {a.workspaceId && !a.workspaces && <div className="mt-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>{t(labels.reloadWorkspaces)}</Button>
            </div>}
            {a.workspaces && a.workspaces.length > 1 && <div className="mt-2 flex flex-wrap items-center gap-2">
              <label htmlFor={`workspace-${a.id}`}>{t(labels.workspace)}</label>
              <select id={`workspace-${a.id}`} value={switching?.accountId === a.id ? switching.workspaceId : a.workspaceId ?? ''} disabled={busy} className="max-w-48 rounded bg-background text-foreground"
                onChange={event => action.mutate({ accountId: a.id, workspaceId: event.target.value })}>
                {a.workspaces.map(w => <option key={w.accountId} value={w.accountId}>
                  {w.name || (w.kind === 'personal' ? t(labels.personal) : t(labels.workspaceUnknown, { id: w.accountId.slice(0, 8) }))}
                </option>)}
              </select>
              {switching?.accountId === a.id && <span role="status" className="inline-flex items-center gap-1.5">
                <Loader2 aria-hidden="true" className="size-3 motion-safe:animate-spin" /> {t(labels.switching)}
              </span>}
            </div>}
          </>}
          control={<div className="flex items-center gap-2">
            {!a.signedIn ? <Button variant="ghost" size="sm" disabled={busy || !!login} onClick={() => signIn(a.id)}>{t(labels.signIn)}</Button> : a.id === data?.current
              ? <span className="flex items-center gap-2 text-xs"><span className="size-1.5 rounded-full bg-emerald-500" />{t(labels.current)}</span>
              : <Button variant="ghost" size="sm" disabled={busy} onClick={() => action.mutate(() => api.codexAccountSelect(a.id))}>{t(labels.use)}</Button>}
            {a.id !== 'default' && a.id !== data?.current && <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t(labels.options)}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent><DropdownMenuItem disabled={busy} onSelect={() => action.mutate(() => api.codexAccountRemove(a.id))}>{t(labels.remove)}</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>}
          </div>} />
      ))}
      {data && signedIn.length === 0 && !login && <Button size="sm" disabled={busy} onClick={() => signIn()}>{t(labels.chatgpt)}</Button>}
      {login && <div className="space-y-2 text-sm" role="status">
        <p>{t(labels.waiting)}</p>
        {login.code && <p>{t(labels.code)} <strong className="select-all font-mono">{login.code}</strong></p>}
        <Button variant="outline" size="sm" onClick={() => openExternalUrl(login.url)}>{t(labels.reopen)}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => action.mutate(api.codexAccountCancel)}>{t(labels.cancel)}</Button>
      </div>}
      {(signedIn.length > 1 || signedIn.some(a => (a.workspaces?.length ?? 0) > 1)) && data && <SettingsRow title={t(labels.automatic)}
        description={t(labels.description)}
        control={<Switch aria-label={t(labels.automatic)} checked={data.automatic} disabled={busy}
          onCheckedChange={enabled => action.mutate(() => api.codexAccountAutomatic(enabled))} />} />}
      {busy && !switching && !login && <p className="text-xs text-muted-foreground" role="status">{t(labels.updating)}</p>}
      {data?.message && <p className="text-xs text-muted-foreground" role="status">{status(intl, data)}</p>}
      {error && <p className="text-xs text-destructive" role="alert">{localizeError(intl, error.message)}</p>}
    </SettingsSection>
  )
}
