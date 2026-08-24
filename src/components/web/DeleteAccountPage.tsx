import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { OperonMark } from './OperonMark'
import { deleteAccount, ensureAccessToken } from '@/lib/web-auth'

type Phase = 'checking' | 'ready' | 'signed-out' | 'deleting' | 'failed'

/**
 * Public account-deletion page, served at `/delete-account`.
 *
 * Google Play requires a publicly reachable URL for deletion requests — the
 * in-app path (More → Delete account) satisfies Apple, but not Play, which
 * wants a link it can list in the store entry. So this renders *outside*
 * {@link WebAuthGate}: the gate would demand a machine be selected first, and
 * someone who no longer uses operon has no reason to have one online just to
 * close their account.
 *
 * It deletes for real when the browser already has a session, which is the
 * common case since this is the same origin as the web app. Without one it
 * explains the in-app route rather than pretending to work — signing in from
 * here would bounce through the OAuth callback and land back on the app.
 */
export function DeleteAccountPage() {
  const intl = useIntl()
  const [phase, setPhase] = useState<Phase>('checking')

  useEffect(() => {
    void (async () => {
      setPhase((await ensureAccessToken()) ? 'ready' : 'signed-out')
    })()
  }, [])

  const run = async () => {
    setPhase('deleting')
    // On success this navigates to '/', so there is no success state here.
    if (!(await deleteAccount())) setPhase('failed')
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-border/40 bg-muted/10 p-6">
        <div className="flex items-center gap-2.5">
          <OperonMark className="h-7 w-7" />
          <div className="space-y-0.5">
            <div className="logo text-sm uppercase text-foreground">operon</div>
            <p className="text-xs text-muted-foreground">
              {intl.formatMessage({
                id: 'web.deleteAccount.subtitle',
                defaultMessage: 'Delete your account',
              })}
            </p>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border/40 bg-background/40 p-4">
          <p className="text-sm font-medium text-foreground/85">
            {intl.formatMessage({
              id: 'web.deleteAccount.whatHappens',
              defaultMessage: 'What gets deleted',
            })}
          </p>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            <li>
              {intl.formatMessage({
                id: 'web.deleteAccount.item.account',
                defaultMessage: 'Your account and the sign-in identities linked to it.',
              })}
            </li>
            <li>
              {intl.formatMessage({
                id: 'web.deleteAccount.item.machines',
                defaultMessage: 'Every paired machine, and any device registered for notifications.',
              })}
            </li>
            <li>
              {intl.formatMessage({
                id: 'web.deleteAccount.item.sessions',
                defaultMessage: 'All active sessions. This cannot be undone.',
              })}
            </li>
          </ul>
          <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
            {intl.formatMessage({
              id: 'web.deleteAccount.item.localData',
              defaultMessage:
                'Your projects, files and conversations live on your own machines and are not touched — operon never stored them.',
            })}
          </p>
        </div>

        {phase === 'checking' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {intl.formatMessage({ id: 'web.auth.loading', defaultMessage: 'Loading…' })}
          </div>
        )}

        {phase === 'signed-out' && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {intl.formatMessage({
                id: 'web.deleteAccount.signedOut',
                defaultMessage:
                  'Sign in to operon first, then open More → Delete account. The same option is in the mobile app.',
              })}
            </p>
            <Button size="sm" variant="secondary" className="h-8" onClick={() => (window.location.href = '/')}>
              {intl.formatMessage({ id: 'web.deleteAccount.openOperon', defaultMessage: 'Open operon' })}
            </Button>
          </div>
        )}

        {(phase === 'ready' || phase === 'deleting' || phase === 'failed') && (
          <div className="space-y-3">
            {phase === 'failed' && (
              <div className="flex items-center gap-2 text-xs text-destructive">
                {intl.formatMessage({
                  id: 'web.deleteAccount.failed',
                  defaultMessage: "Couldn't delete your account. Try again.",
                })}
              </div>
            )}
            <Button
              size="sm"
              variant="destructive"
              className="h-8 gap-1.5"
              disabled={phase === 'deleting'}
              onClick={() => void run()}
            >
              {phase === 'deleting' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {intl.formatMessage({
                id: 'web.deleteAccount.confirm',
                defaultMessage: 'Permanently delete my account',
              })}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** True when the browser is on the public deletion page. */
export function isDeleteAccountRoute(): boolean {
  return window.location.pathname === '/delete-account'
}
