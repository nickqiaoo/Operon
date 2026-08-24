import { useCallback, useEffect, useState } from 'react'
import { FormattedMessage, useIntl, type IntlShape } from 'react-intl'
import { AlertCircle, Cloud, Github, Loader2, LogOut } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { api } from '@/lib/api'
import { syncAnalyticsIdentity } from '@/lib/analytics'
import { RemoteEncryptionSettings } from './RemoteEncryptionSettings'

// Which broker this build talks to is decided in the main process
// (server/src/gateway/saas/broker.ts) and never surfaces here — it is not a
// choice, and naming it would only invite the question of how to change it.
// Users flip the switch; the machine name defaults to the OS hostname
// server-side. A node token the broker refuses is dropped there too, so this
// page just goes back to reading "Not connected".
interface SaasStatus {
  connected: boolean
  userId?: string
  nodeId?: string
  label?: string
  loginError?: SaasLoginError
}

interface SaasLoginError {
  code?: string
  message: string
}

// Mirrors the broker's providers (broker/oauth.go startAuthorize).
type SaasAuthProvider = 'github' | 'apple'

// Copied rather than imported from WebAuthGate: that module is the web client's
// auth gate and pulling it in here would drag the whole web sign-in flow into
// the desktop bundle.
function AppleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.73-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.75 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.87.69 1.19-.02 1.94-1.08 2.66-2.14.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.34-3.5M14.88 5.7c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.69.97.07 1.96-.49 2.58-1.22" />
    </svg>
  )
}

function normalizeLoginError(err: unknown, fallback: string): SaasLoginError {
  if (err instanceof Error) return { message: err.message }
  if (typeof err === 'string' && err) return { message: err }
  return { message: fallback }
}

function getLoginErrorCopy(
  err: SaasLoginError,
  intl: IntlShape,
): { title: string; description: string } {
  if (err.code === 'github_oauth_timeout') {
    return {
      title: intl.formatMessage({
        id: 'settings.saas.error.githubTimeout.title',
        defaultMessage: 'GitHub sign-in timed out',
      }),
      description: intl.formatMessage({
        id: 'settings.saas.error.githubTimeout.desc',
        defaultMessage:
          'The broker could not reach GitHub in time. Please retry. If you are in mainland China, switch networks or use a proxy and try again.',
      }),
    }
  }

  return {
    title: intl.formatMessage({
      id: 'settings.saas.error.signInFailed',
      defaultMessage: 'Sign-in failed',
    }),
    description: err.message,
  }
}

export function SaasSettings() {
  const intl = useIntl()
  const [status, setStatus] = useState<SaasStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  // Which account to sign in with is asked here, not in the browser: the broker
  // hands the request straight to the provider, so a still-valid GitHub session
  // would authorize silently and there would never be a page to choose on.
  const [choosing, setChoosing] = useState(false)
  const [err, setErr] = useState<SaasLoginError | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await api.saasGetStatus()
      setStatus(next)
      // Signing in or out here changes who this desktop client is; without
      // this the identity would stay stale until the next app launch.
      syncAnalyticsIdentity(next.connected ? next.userId ?? null : null)
    } catch (e) {
      setErr(
        normalizeLoginError(
          e,
          intl.formatMessage({
            id: 'settings.saas.error.loadStatus',
            defaultMessage: 'Failed to load status',
          }),
        ),
      )
    } finally {
      setLoading(false)
    }
  }, [intl])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll while waiting for the browser sign-in to complete.
  useEffect(() => {
    if (!connecting) return
    const id = setInterval(() => void refresh(), 2000)
    return () => clearInterval(id)
  }, [connecting, refresh])

  useEffect(() => {
    if (connecting && status?.connected) {
      setConnecting(false)
      setErr(null)
    }
  }, [connecting, status?.connected])

  useEffect(() => {
    if (!status?.loginError) return
    setErr(status.loginError)
    setConnecting(false)
  }, [status?.loginError?.code, status?.loginError?.message])

  async function connect(provider: SaasAuthProvider) {
    setErr(null)
    setChoosing(false)
    setConnecting(true)
    const startFailed = intl.formatMessage({
      id: 'settings.saas.error.startSignIn',
      defaultMessage: 'Failed to start sign-in',
    })
    try {
      // Empty label → server defaults it to this machine's hostname.
      const res = await api.saasLogin(provider, '')
      if (res.error || !res.authorizeUrl) {
        setErr({ code: res.code, message: res.message ?? res.error ?? startFailed })
        setConnecting(false)
        return
      }
      window.electronAPI?.openExternal(res.authorizeUrl)
    } catch (e) {
      setErr(normalizeLoginError(e, startFailed))
      setConnecting(false)
    }
  }

  async function disconnect() {
    setErr(null)
    await api.saasLogout().catch(() => undefined)
    setConnecting(false)
    setChoosing(false)
    await refresh()
  }

  function onToggle(next: boolean) {
    if (next) {
      setErr(null)
      setChoosing(true)
    } else {
      setChoosing(false)
      void disconnect()
    }
  }

  const connected = status?.connected === true
  const loginErrorCopy = err ? getLoginErrorCopy(err, intl) : null

  return (
    <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <h3 className="mb-1 text-sm font-semibold">
            <FormattedMessage id="settings.saas.title" defaultMessage="Remote" />
          </h3>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.saas.desc"
              defaultMessage="Connect this machine to operon so you can drive its agents from the web app anywhere. Requests are tunneled back to this computer, with content protected by end-to-end encryption."
            />
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />{' '}
          <FormattedMessage id="settings.saas.loading" defaultMessage="Loading…" />
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/40 p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                {connecting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />{' '}
                    <FormattedMessage id="settings.saas.connecting" defaultMessage="Connecting…" />
                  </>
                ) : connected ? (
                  <span className="text-emerald-500">
                    <FormattedMessage id="settings.saas.connected" defaultMessage="Connected" />
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    <FormattedMessage id="settings.saas.notConnected" defaultMessage="Not connected" />
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {connecting ? (
                  <FormattedMessage
                    id="settings.saas.waitingSignIn"
                    defaultMessage="Waiting for browser sign-in…"
                  />
                ) : choosing ? (
                  <FormattedMessage
                    id="settings.saas.chooseProvider"
                    defaultMessage="Choose how to sign in"
                  />
                ) : connected ? (
                  status?.label || status?.nodeId
                ) : (
                  <FormattedMessage
                    id="settings.saas.turnOnHint"
                    defaultMessage="Turn on to make this machine reachable from the web app"
                  />
                )}
              </p>
            </div>
            <Switch
              checked={connected || connecting || choosing}
              disabled={connecting}
              onCheckedChange={onToggle}
            />
          </div>

          {choosing && (
            <div className="space-y-2 rounded-lg border border-border/40 bg-background/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8 gap-1.5"
                  onClick={() => void connect('github')}
                >
                  <Github className="h-3.5 w-3.5" />
                  <FormattedMessage id="settings.saas.continueGithub" defaultMessage="Continue with GitHub" />
                </Button>
                {/*
                  Apple's HIG fixes the wording, glyph and solid black/white
                  treatment, so this button deliberately skips the app's Button
                  variants — same as the web sign-in card (WebAuthGate). Hover
                  darkens via alpha so no palette color is hardcoded.
                */}
                <button
                  type="button"
                  onClick={() => void connect('apple')}
                  className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-black px-3 text-sm font-medium text-white transition-colors hover:bg-black/80 dark:bg-white dark:text-black dark:hover:bg-white/80"
                >
                  <AppleMark className="h-3.5 w-3.5" />
                  <FormattedMessage id="settings.saas.continueApple" defaultMessage="Sign in with Apple" />
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                <FormattedMessage
                  id="settings.saas.providerHint"
                  defaultMessage="Sign-in opens in your browser and uses whichever account is already signed in there. Sign out of that account first to switch."
                />
              </p>
            </div>
          )}

          {connected ? (
            // No broker or machine detail panel: the broker is not the user's
            // concern, and the machine name is already on the line above.
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => void disconnect()}>
              <LogOut className="h-3.5 w-3.5" />{' '}
              <FormattedMessage id="settings.saas.signOut" defaultMessage="Sign out" />
            </Button>
          ) : connecting || choosing ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-xs"
              onClick={() => {
                setConnecting(false)
                setChoosing(false)
              }}
            >
              <FormattedMessage id="settings.saas.cancel" defaultMessage="Cancel" />
            </Button>
          ) : null}
          {connected && <RemoteEncryptionSettings />}
        </>
      )}

      {err && (
        <Alert variant="destructive" className="border-destructive/25 bg-destructive/5">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{loginErrorCopy?.title}</AlertTitle>
          <AlertDescription>
            <p>{loginErrorCopy?.description}</p>
            {err.code && (
              <p className="font-mono text-[11px] text-destructive/70">
                <FormattedMessage
                  id="settings.saas.errorCode"
                  defaultMessage="code: {code}"
                  values={{ code: err.code }}
                />
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
