import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { toast } from 'sonner'
import { Loader2, Monitor, LogOut, RefreshCw, ChevronUp, Github } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OperonMark } from './OperonMark'
import { LandingIntro } from './LandingIntro'
import { useThemeStore, applyTheme } from '@/stores/theme-store'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  fetchNodes,
  handleCallback,
  ensureAccessToken,
  isCallbackRoute,
  installNativeAuthListener,
  login,
  reviewerLogin,
  logout,
  setSelectedNode,
  getSelectedNodeId,
  getSelectedNodeLabel,
  clearSelectedNode,
  deleteAccount,
  getAuthProvider,
  getUserId,
  NODE_OFFLINE_EVENT,
  type CallbackResult,
  type WebNode,
} from '@/lib/web-auth'
import { resetNodeScopedCaches } from '@/lib/node-cache-reset'
import { syncAnalyticsIdentity } from '@/lib/analytics'
import { useAppShellStore } from '@/stores/app-shell-store'
import { hasRemotePairing } from '@/lib/e2ee/device-store'
import { nodeRequiresPairing } from '@/lib/e2ee/node-mode'
import { SecurePairingCard } from './SecurePairingCard'
import { E2EE_PAIRING_REQUIRED_EVENT } from '@/lib/e2ee/secure-fetch'

type Phase = 'loading' | 'login' | 'picker' | 'pairing' | 'ready'

/**
 * Whether this device has to pair before it can use `nodeId`.
 *
 * A stored key answers it locally and for free. Without one the question
 * belongs to the machine, not to us — see `nodeRequiresPairing`, which exists
 * so a headless node running with E2EE off (the App Store review machine, which
 * has no screen to show a pairing QR on) is reachable at all.
 */
async function pairingRequired(nodeId: string): Promise<boolean> {
  if (await hasRemotePairing(nodeId)) return false
  return nodeRequiresPairing(nodeId)
}

/**
 * Web-target gate: blocks the app behind login + node selection. Every request the
 * app makes is tunneled to the chosen node's local backend, so we must know the
 * user (token) and the node before mounting the app. Electron renders <App/>
 * directly and never sees this.
 */
export function WebAuthGate({ children }: { children: React.ReactNode }) {
  const intl = useIntl()
  const [phase, setPhase] = useState<Phase>('loading')
  const [nodes, setNodes] = useState<WebNode[]>([])
  const [loadingNodes, setLoadingNodes] = useState(false)
  const [pairingNode, setPairingNode] = useState<{ nodeId: string; label: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)
  const theme = useThemeStore((s) => s.theme)
  // On phones the machine control lives in the More tab instead of a floating
  // pill (the corner badge collides with the bottom tab bar).
  const isMobile = useIsMobile()
  // Read once per render rather than held in state: it is written before the
  // browser leaves for the provider, so by the time this component can render a
  // picker it can no longer change.
  const signedInWith = getAuthProvider()

  // The login/picker phases render WITHOUT mounting <App/>, so App's own theme
  // effect never runs there. Apply the theme here so every gate phase honors the
  // user's choice and auto-adapts to the OS in "system" mode.
  useEffect(() => {
    applyTheme(theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (theme === 'system') applyTheme('system')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  useEffect(() => {
    const onNodeOffline = () => {
      toast.error(intl.formatMessage({ id: 'web.auth.nodeOffline.title', defaultMessage: 'Machine offline' }), {
        id: 'operon-node-offline',
        description: intl.formatMessage({
          id: 'web.auth.nodeOffline.desc',
          defaultMessage: 'Open operon on the selected machine, then refresh or choose another machine.',
        }),
      })
    }
    window.addEventListener(NODE_OFFLINE_EVENT, onNodeOffline)
    return () => window.removeEventListener(NODE_OFFLINE_EVENT, onNodeOffline)
  }, [intl])

  useEffect(() => {
    const onPairingRequired = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId ?? getSelectedNodeId()
      if (!nodeId) return
      setPairingNode({ nodeId, label: getSelectedNodeLabel() ?? nodeId.slice(0, 8) })
      setPhase('pairing')
    }
    window.addEventListener(E2EE_PAIRING_REQUIRED_EVENT, onPairingRequired)
    return () => window.removeEventListener(E2EE_PAIRING_REQUIRED_EVENT, onPairingRequired)
  }, [])

  // Bind analytics to the signed-in account whenever the gate settles on an
  // authenticated phase. Keyed on `phase` rather than done inside `boot()`
  // because sign-in arrives through several paths (boot, the OAuth callback,
  // the native listener, the node picker) that all converge here.
  useEffect(() => {
    if (phase === 'loading') return
    syncAnalyticsIdentity(phase === 'login' ? null : getUserId())
  }, [phase])

  useEffect(() => {
    const boot = async () => {
      if (isCallbackRoute()) {
        const result = await handleCallback()
        if (!result.ok) {
          // Previously this bounced to the login page with no explanation, which
          // read as "GitHub login just doesn't work" — most often it's a PKCE
          // verifier lost when an installed PWA handed the sign-in to Safari.
          toast.error(
            intl.formatMessage({ id: 'web.auth.signInFailed', defaultMessage: "Couldn't complete sign-in" }),
            {
              id: 'operon-signin-failed',
              description:
                result.reason ??
                intl.formatMessage({
                  id: 'web.auth.signInFailed.desc',
                  defaultMessage: 'Try signing in again.',
                }),
            }
          )
          return setPhase('login')
        }
      }
      if (!(await ensureAccessToken())) return setPhase('login')
      const selectedNodeId = getSelectedNodeId()
      if (selectedNodeId) {
        if (!(await pairingRequired(selectedNodeId))) return setPhase('ready')
        setPairingNode({ nodeId: selectedNodeId, label: getSelectedNodeLabel() ?? selectedNodeId.slice(0, 8) })
        return setPhase('pairing')
      }
      await loadNodes()
      setPhase('picker')
    }
    void boot()
    // `intl` is stable for the life of the provider; boot must run exactly once
    // or a re-run would replay an already-consumed OAuth code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Native sign-in doesn't come back as a navigation — iOS hands the app a
  // `operon://auth/callback` URL while this component stays mounted, so the
  // gate has to advance from an event instead of from `boot()`. No-op on web.
  useEffect(() => {
    return installNativeAuthListener((result) => {
      void advanceAfterSignIn(result)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Shared by every sign-in that completes without a page navigation: the
  // native deep link above, and the review password form. `boot()` handles the
  // browser's own `/auth/callback` arrival instead, because that one does
  // navigate.
  const advanceAfterSignIn = async (result: CallbackResult) => {
    if (!result.ok) {
      toast.error(
        intl.formatMessage({ id: 'web.auth.signInFailed', defaultMessage: "Couldn't complete sign-in" }),
        { id: 'operon-signin-failed', description: result.reason }
      )
      return setPhase('login')
    }
    const selectedNodeId = getSelectedNodeId()
    if (selectedNodeId) {
      if (!(await pairingRequired(selectedNodeId))) return setPhase('ready')
      setPairingNode({ nodeId: selectedNodeId, label: getSelectedNodeLabel() ?? selectedNodeId.slice(0, 8) })
      return setPhase('pairing')
    }
    await loadNodes()
    setPhase('picker')
  }

  const loadNodes = async () => {
    setLoadingNodes(true)
    try {
      // Revoked nodes are dropped rather than listed as unpickable: signing a
      // machine out is meant to remove it, and a row that can only be looked at
      // reads as an error. They stay in the broker's response for
      // MobileMoreScreen, which has to tell a user their *selected* machine was
      // revoked.
      setNodes((await fetchNodes()).filter((n) => !n.revoked))
    } finally {
      setLoadingNodes(false)
    }
  }

  const pick = async (n: WebNode) => {
    setSelectedNode(n.nodeId, n.label || n.nodeId.slice(0, 8))
    // Deciding what comes next can take a tunnel round trip now, and a picker
    // that keeps rendering after the tap reads as one that didn't register it.
    setPhase('loading')
    if (!(await pairingRequired(n.nodeId))) return setPhase('ready')
    setPairingNode({ nodeId: n.nodeId, label: n.label || n.nodeId.slice(0, 8) })
    setPhase('pairing')
  }

  const runDeleteAccount = async () => {
    setDeletingAccount(true)
    // A success navigates away, so only the failure needs anything rendered.
    if (await deleteAccount()) return
    setDeletingAccount(false)
    setConfirmDelete(false)
    toast.error(
      intl.formatMessage({
        id: 'web.auth.deleteAccount.failed',
        defaultMessage: "Couldn't delete your account. Try again.",
      })
    )
  }

  const switchMachine = () => {
    clearSelectedNode()
    // This path swaps the node without reloading, so nothing else drops the
    // caches keyed on the old node's ids.
    resetNodeScopedCaches()
    setNodes([])
    setPhase('picker')
    void loadNodes()
  }

  if (phase === 'ready') {
    return (
      <>
        {children}
        {!isMobile && (
          <MachineBadge
            label={
              getSelectedNodeLabel() ??
              intl.formatMessage({ id: 'web.auth.machineFallback', defaultMessage: 'machine' })
            }
            onSwitch={switchMachine}
            onSignOut={logout}
          />
        )}
      </>
    )
  }

  if (phase === 'login') {
    return <LoginLanding onSignedIn={advanceAfterSignIn} />
  }

  if (phase === 'pairing' && pairingNode) {
    return (
      <SecurePairingCard
        nodeId={pairingNode.nodeId}
        nodeLabel={pairingNode.label}
        onPaired={() => setPhase('ready')}
        onBack={switchMachine}
      />
    )
  }

  // loading / picker — a quiet centered card.
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-5 rounded-xl border border-border/50 bg-muted/10 p-6">
        <div className="flex items-center gap-2.5">
          <OperonMark className="h-7 w-7" />
          <div className="space-y-0.5">
            <div className="logo text-sm uppercase text-foreground">operon</div>
            <p className="text-xs text-muted-foreground">
              {phase === 'picker'
                ? intl.formatMessage({
                    id: 'web.auth.chooseMachine',
                    defaultMessage: 'Choose a machine to control',
                  })
                : intl.formatMessage({ id: 'web.auth.loading', defaultMessage: 'Loading…' })}
            </p>
          </div>
        </div>

        {phase === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {intl.formatMessage({ id: 'web.auth.loading', defaultMessage: 'Loading…' })}
          </div>
        )}

        {phase === 'picker' && (
          <div className="space-y-3">
            {loadingNodes ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {intl.formatMessage({ id: 'web.auth.loadingMachines', defaultMessage: 'Loading machines…' })}
              </div>
            ) : nodes.length === 0 ? (
              <div className="space-y-2 rounded-lg border border-dashed border-border/50 p-4 text-xs text-muted-foreground">
                <p>
                  {intl.formatMessage({
                    id: 'web.auth.noMachines',
                    defaultMessage:
                      'No machines yet. Open the operon app on your computer and connect it to the SaaS, then refresh.',
                  })}
                </p>
                {/* GitHub and Apple are deliberately separate accounts, so an
                    empty list is just as likely to mean "signed in the other
                    way" as "never paired a machine". Saying so here is the
                    whole mitigation — there is no automatic linking to fall
                    back on. Omitted when we don't know which button was used
                    (a session predating that being recorded), since naming the
                    wrong one sends the user in a circle. */}
                {signedInWith && (
                  <p className="border-t border-border/40 pt-2">
                    {intl.formatMessage(
                      {
                        id: 'web.auth.noMachines.otherProvider',
                        defaultMessage:
                          'You are signed in with {current}. Signing in with {other} creates a separate account — if you paired your machine that way, sign out and use {other} instead.',
                      },
                      {
                        current: signedInWith === 'apple' ? 'Apple' : 'GitHub',
                        other: signedInWith === 'apple' ? 'GitHub' : 'Apple',
                      },
                    )}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                {nodes.map((n) => (
                  <button
                    key={n.nodeId}
                    disabled={!n.online}
                    onClick={() => void pick(n)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-border/50 bg-background/40 p-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-sm">{n.label || n.nodeId.slice(0, 8)}</span>
                    <span className={`text-xs ${n.online ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                      {n.online
                        ? intl.formatMessage({ id: 'web.auth.status.online', defaultMessage: 'online' })
                        : intl.formatMessage({ id: 'web.auth.status.offline', defaultMessage: 'offline' })}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between pt-1">
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => void loadNodes()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {intl.formatMessage({ id: 'web.auth.refresh', defaultMessage: 'Refresh' })}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => logout()}>
                <LogOut className="h-3.5 w-3.5" />
                {intl.formatMessage({ id: 'web.auth.signOut', defaultMessage: 'Sign out' })}
              </Button>
            </div>

            {/*
              Deleting the account has to be reachable from inside the app
              (Guideline 5.1.1(v)), and the copy in MobileMoreScreen is not:
              that screen lives behind a selected machine, so an account with no
              machines — a brand-new one, or one whose machines were revoked —
              stops here with sign-out as its only exit. Same flow, same
              wording, one confirmation step, kept visually quiet so it doesn't
              compete with picking a machine.
            */}
            {confirmDelete ? (
              <div className="space-y-2 rounded-lg border border-border/40 bg-muted/10 p-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {intl.formatMessage({
                    id: 'web.auth.deleteAccount.confirm',
                    defaultMessage:
                      'This permanently removes your account, unpairs every machine, and cannot be undone. Files and projects on your machines are not touched.',
                  })}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-8 gap-1.5"
                    disabled={deletingAccount}
                    onClick={() => void runDeleteAccount()}
                  >
                    {deletingAccount && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {intl.formatMessage({ id: 'web.auth.deleteAccount', defaultMessage: 'Delete account' })}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 text-xs"
                    disabled={deletingAccount}
                    onClick={() => setConfirmDelete(false)}
                  >
                    {intl.formatMessage({ id: 'common.cancel', defaultMessage: 'Cancel' })}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-destructive hover:underline"
              >
                {intl.formatMessage({ id: 'web.auth.deleteAccount', defaultMessage: 'Delete account' })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The marketing-grade login page. On desktop it's two columns: brand + product
 * intro on the left, the sign-in box in a right rail. On mobile it collapses to a
 * single cohesive column — brand, then the sign-in block inline, then the intro —
 * rather than a separate boxed panel. The outer container owns its own scroll
 * because the global `body` is `overflow:hidden` (for the app shell); without it
 * the content below the fold would be unreachable on a phone.
 */
function LoginLanding({ onSignedIn }: { onSignedIn: (result: CallbackResult) => void | Promise<void> }) {
  const intl = useIntl()

  return (
    <div className="h-[100dvh] overflow-y-auto bg-background [scroll-padding-top:env(safe-area-inset-top)]">
      <div className="flex min-h-full flex-col lg:grid lg:min-h-[100dvh] lg:grid-cols-[1.05fr_0.95fr]">
        {/* Left on desktop; the whole single column on mobile — brand, then the
            sign-in block inline, then the product intro. */}
        <main
          className="flex flex-col px-6 pb-12 pt-[calc(env(safe-area-inset-top)+3rem)] sm:px-10 lg:min-h-[100dvh] lg:justify-center lg:px-14 lg:py-16"
          style={{ backgroundImage: 'var(--gradient-glow)' }}
        >
          <div className="mx-auto w-full max-w-2xl space-y-10">
            <header className="space-y-5">
              <OperonMark className="h-14 w-14 drop-shadow-[0_0_24px_rgba(99,88,220,0.2)]" />
              <div className="space-y-2">
                <h1 className="logo text-3xl uppercase text-foreground">operon</h1>
                <p className="text-lg font-light tracking-wide text-muted-foreground/90">
                  {intl.formatMessage({
                    id: 'web.auth.login.tagline',
                    defaultMessage: 'One Interface. Every Agent.',
                  })}
                </p>
              </div>
            </header>

            {/* Mobile: sign-in inline right under the brand so the page reads as one
                cohesive column. Hidden on desktop, where it lives in the right rail. */}
            <div className="lg:hidden">
              <LoginCard onSignedIn={onSignedIn} />
            </div>

            <LandingIntro />

            {/* These live on the marketing site, not here: this origin is the
                app, and the store listings point at operon.chatcode.top. */}
            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/40 pt-5 text-xs text-muted-foreground">
              <a
                className="transition-colors hover:text-foreground"
                href="https://operon.chatcode.top/support"
                target="_blank"
                rel="noopener noreferrer"
              >
                {intl.formatMessage({ id: 'web.auth.footer.support', defaultMessage: 'Support' })}
              </a>
              <a
                className="transition-colors hover:text-foreground"
                href="https://operon.chatcode.top/privacy"
                target="_blank"
                rel="noopener noreferrer"
              >
                {intl.formatMessage({ id: 'web.auth.footer.privacy', defaultMessage: 'Privacy' })}
              </a>
            </footer>
          </div>
        </main>

        {/* Desktop only — sign-in box in the right rail (mobile renders it inline
            under the brand above). */}
        <aside className="hidden bg-muted/10 px-6 py-12 lg:flex lg:sticky lg:top-0 lg:h-[100dvh] lg:items-center lg:justify-center lg:border-l lg:border-border/50">
          <LoginCard onSignedIn={onSignedIn} />
        </aside>
      </div>
    </div>
  )
}

function LoginCard({ onSignedIn }: { onSignedIn: (result: CallbackResult) => void | Promise<void> }) {
  const intl = useIntl()

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-foreground">
          {intl.formatMessage({ id: 'web.auth.login.title', defaultMessage: 'Sign in' })}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {intl.formatMessage({
            id: 'web.auth.login.desc',
            defaultMessage: 'Connect your account to reach and control the machines running operon.',
          })}
        </p>
      </div>

      <div className="space-y-2">
        <Button className="h-10 w-full gap-2" onClick={() => void login('github')}>
          <Github className="h-4 w-4" />
          {intl.formatMessage({ id: 'web.auth.login.github', defaultMessage: 'Continue with GitHub' })}
        </Button>

        {/*
          Guideline 4.8: an app that offers third-party sign-in must also offer
          Sign in with Apple. Apple's HIG fixes the wording, the glyph and the
          solid black/white treatment, so this button deliberately does NOT use
          the app's own Button variants.
        */}
        <button
          type="button"
          onClick={() => void login('apple')}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-black text-sm font-medium text-white transition-opacity hover:opacity-90 dark:bg-white dark:text-black"
        >
          <AppleMark className="h-4 w-4" />
          {intl.formatMessage({ id: 'web.auth.login.apple', defaultMessage: 'Sign in with Apple' })}
        </button>
      </div>

      <ReviewerSignIn onSignedIn={onSignedIn} />
    </div>
  )
}

/**
 * Password sign-in for an App Store reviewer, collapsed behind a link.
 *
 * Visible rather than hidden on purpose: a reviewer has to be able to find it
 * from the review notes, and a genuinely concealed path would itself be a
 * problem under Guideline 2.3.1. It is also harmless in the open — the broker
 * 404s the endpoint unless review credentials are configured, and there is
 * nothing to guess at beyond a password.
 *
 * See `broker/reviewer.go` for why neither OAuth button works for a reviewer.
 */
function ReviewerSignIn({ onSignedIn }: { onSignedIn: (result: CallbackResult) => void | Promise<void> }) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !username || !password) return
    setBusy(true)
    try {
      await onSignedIn(await reviewerLogin(username, password))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        {intl.formatMessage({ id: 'web.auth.login.reviewer', defaultMessage: 'App Review sign-in' })}
      </button>
    )
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2 rounded-lg border border-border/40 bg-muted/10 p-3">
      <p className="text-xs text-muted-foreground">
        {intl.formatMessage({
          id: 'web.auth.login.reviewerHint',
          defaultMessage: 'For App Store review. Use the credentials from the review notes.',
        })}
      </p>
      <Input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={intl.formatMessage({ id: 'web.auth.login.username', defaultMessage: 'Username' })}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="username"
        className="h-9 border-border/50"
      />
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={intl.formatMessage({ id: 'web.auth.login.password', defaultMessage: 'Password' })}
        autoComplete="current-password"
        className="h-9 border-border/50"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="secondary" className="h-8 gap-1.5" disabled={busy || !username || !password}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {intl.formatMessage({ id: 'web.auth.login.signIn', defaultMessage: 'Sign in' })}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>
          {intl.formatMessage({ id: 'web.auth.login.cancel', defaultMessage: 'Cancel' })}
        </Button>
      </div>
    </form>
  )
}

function AppleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.73-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.75 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.87.69 1.19-.02 1.94-1.08 2.66-2.14.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.34-3.5M14.88 5.7c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.69.97.07 1.96-.49 2.58-1.22" />
    </svg>
  )
}

/**
 * Web-only corner pill showing which machine is being controlled, with a menu to
 * switch machines or sign out. Renders over the app (Electron never sees it).
 *
 * It's fixed to the viewport rather than rendered inside the sidebar, but it is
 * *visually* part of it — the sidebar's bottom actions reserve the room it sits
 * in (`pb-12` on web). So it has to hide with the sidebar too: left in place on
 * collapse it would float over the center column and cover the composer.
 */
function MachineBadge({
  label,
  onSwitch,
  onSignOut,
}: {
  label: string
  onSwitch: () => void
  onSignOut: () => void
}) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const sidebarCollapsed = useAppShellStore((s) => s.sidebarCollapsed)
  // Don't leave the menu hanging open for the next expand.
  useEffect(() => {
    if (sidebarCollapsed) setOpen(false)
  }, [sidebarCollapsed])
  if (sidebarCollapsed) return null
  return (
    <div className="fixed bottom-3 left-3 z-[60] text-xs">
      {open && (
        <div className="mb-1.5 w-44 overflow-hidden rounded-lg border border-border/50 bg-popover/95 shadow-float backdrop-blur">
          <button
            onClick={() => {
              setOpen(false)
              onSwitch()
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
          >
            <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
            {intl.formatMessage({ id: 'web.auth.switchMachine', defaultMessage: 'Switch machine' })}
          </button>
          <button
            onClick={() => {
              setOpen(false)
              onSignOut()
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
          >
            <LogOut className="h-3.5 w-3.5 text-muted-foreground" />
            {intl.formatMessage({ id: 'web.auth.signOut', defaultMessage: 'Sign out' })}
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-border/50 bg-popover/90 px-2.5 py-1.5 text-muted-foreground shadow-card backdrop-blur transition-colors hover:bg-muted/50"
      >
        <Monitor className="h-3.5 w-3.5" />
        <span className="max-w-[140px] truncate text-foreground">{label}</span>
        <ChevronUp className={`h-3 w-3 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
    </div>
  )
}
