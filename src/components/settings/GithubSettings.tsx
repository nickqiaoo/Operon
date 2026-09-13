import { useCallback, useEffect, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Eye, EyeOff, Loader2, CheckCircle2, Trash2, Link2, ExternalLink, XCircle, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { runIntegrationFlow } from "@/lib/integration-flow"
import { openExternalUrl } from "@/lib/open-external"
import { GithubIcon } from "@/components/icons/GithubIcon"
import type { GithubCoverageProject, IntegrationAppStatus } from "@/types/integrations"

const inputCn =
  "w-full px-3 py-2 text-sm bg-muted/30 rounded-xl border border-transparent hover:bg-muted/50 focus:bg-background focus:outline-none focus:border-tint/40 focus:ring-1 focus:ring-tint/10 placeholder:text-muted-foreground/40 transition-colors"

const tokenCn = inputCn + " font-mono pr-10"

export function GithubSettings() {
  return (
    <div className="space-y-6">
      <GithubAppCard />
      <GithubPatCard />
    </div>
  )
}

// The operon GitHub App (docs/linear-github/design.md §4.2): installed once
// per GitHub account or org, covering the repositories picked there. Task
// PRs and PR-comment steering go through it; the private key never leaves
// the broker, this machine only borrows one-hour repo-scoped tokens.
function GithubAppCard() {
  const intl = useIntl()
  const [status, setStatus] = useState<IntegrationAppStatus | null>(null)
  const [coverage, setCoverage] = useState<GithubCoverageProject[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.integrationAppStatus(), api.integrationGithubCoverage()])
      setStatus(s)
      setCoverage(c.projects)
      setError(s.brokerError ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : intl.formatMessage({ id: "settings.loadFailed", defaultMessage: "Failed to load" }))
    } finally {
      setLoading(false)
    }
  }, [intl])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runFlow = async (kind: "github/install" | "github/link") => {
    setBusy(kind)
    setError(null)
    try {
      await runIntegrationFlow(kind, () =>
        kind === "github/install" ? api.integrationGithubAppInstall() : api.integrationGithubAppLink(),
      )
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authorization failed")
    } finally {
      setBusy(null)
    }
  }

  const forget = async (installationId: number) => {
    setBusy(`forget:${installationId}`)
    setError(null)
    try {
      await api.integrationGithubForgetInstallation(installationId)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to forget installation")
    } finally {
      setBusy(null)
    }
  }

  const saasConnected = status?.saasConnected ?? false
  const installs = status?.github.installs ?? []
  const login = status?.github.login ?? ""

  return (
    <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <GithubIcon className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold mb-1">
            <FormattedMessage id="settings.github.app.title" defaultMessage="GitHub App" />
          </h2>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.github.app.desc"
              defaultMessage="Task pull requests and review-comment steering go through the operon GitHub App. Install it once on your account or organization and pick the repositories."
            />
          </p>
        </div>
        {installs.length > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-status-ok">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.github.app.installed" defaultMessage="Installed" />
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <FormattedMessage id="common.loading" defaultMessage="Loading…" />
        </div>
      ) : (
        <>
          {!saasConnected && (
            <p className="text-xs text-muted-foreground/70">
              <FormattedMessage id="settings.github.app.signInFirst" defaultMessage="Sign in on the Remote tab first." />
            </p>
          )}

          {installs.length > 0 && (
            <div className="space-y-2">
              {installs.map((i) => (
                <div
                  key={i.installationId}
                  className="flex items-center justify-between gap-3 rounded-lg bg-background/40 border border-border/40 px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <span className="text-foreground/85 font-medium">{i.accountLogin || `#${i.installationId}`}</span>
                    <span className="text-muted-foreground ml-2">
                      <FormattedMessage
                        id="settings.github.app.repoCount"
                        defaultMessage="{count, plural, one {# repository} other {# repositories}}"
                        values={{ count: i.repos.length }}
                      />
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
                    disabled={busy !== null}
                    onClick={() => void forget(i.installationId)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <FormattedMessage id="settings.github.app.forget" defaultMessage="Forget" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              disabled={!saasConnected || busy !== null}
              onClick={() => void runFlow("github/install")}
            >
              {busy === "github/install" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              <FormattedMessage id="settings.github.app.install" defaultMessage="Install GitHub App" />
            </Button>
            {installs.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-xs"
                onClick={() => openExternalUrl("https://github.com/settings/installations")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <FormattedMessage id="settings.github.app.manage" defaultMessage="Manage on GitHub" />
              </Button>
            )}
            {saasConnected && !login && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-xs"
                disabled={busy !== null}
                onClick={() => void runFlow("github/link")}
              >
                {busy === "github/link" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                <FormattedMessage id="settings.github.app.link" defaultMessage="Link GitHub account" />
              </Button>
            )}
            {login && (
              <span className="text-[11px] text-muted-foreground/60">
                <FormattedMessage id="settings.github.app.asLogin" defaultMessage="Acting as @{login}" values={{ login }} />
              </span>
            )}
          </div>

          {saasConnected && coverage.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">
                <FormattedMessage id="settings.github.app.coverage" defaultMessage="Repository coverage" />
              </div>
              <div className="rounded-lg bg-background/40 border border-border/40 divide-y divide-border/40">
                {coverage.map((p) => (
                  <div key={p.projectId} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <div className="min-w-0 flex items-center gap-2">
                      <span className="text-foreground/85 font-medium truncate">{p.name}</span>
                      {p.repo && <span className="text-muted-foreground font-mono truncate">{p.repo}</span>}
                    </div>
                    {!p.repo ? (
                      <span className="text-muted-foreground/60 shrink-0">
                        <FormattedMessage id="settings.github.app.notGithub" defaultMessage="No GitHub remote" />
                      </span>
                    ) : p.covered ? (
                      <span className="flex items-center gap-1 text-status-ok shrink-0">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <FormattedMessage id="settings.github.app.covered" defaultMessage="Covered" />
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-status-warn shrink-0">
                        <XCircle className="h-3.5 w-3.5" />
                        <FormattedMessage id="settings.github.app.notCovered" defaultMessage="Not covered — install the App on this repo" />
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <div className="flex items-center gap-2 text-xs text-destructive">{error}</div>}
        </>
      )}
    </section>
  )
}

function GithubPatCard() {
  const intl = useIntl()
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(false)
  const [login, setLogin] = useState("")
  const [token, setToken] = useState("")
  const [revealed, setRevealed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.integrationGithubGet()
        if (cancelled) return
        setConfigured(Boolean(res.configured))
        setLogin(res.login ?? "")
        setToken(res.token ?? "")
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : intl.formatMessage({ id: "settings.loadFailed", defaultMessage: "Failed to load" }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = async () => {
    if (!token.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = (await api.integrationGithubSave(token.trim())) as {
        configured?: boolean
        login?: string
        token?: string
        error?: string
      }
      if (res.error || !res.configured) {
        setError(res.error ?? intl.formatMessage({ id: "common.saveFailed", defaultMessage: "Failed to save" }))
        return
      }
      setConfigured(res.configured)
      setLogin(res.login ?? "")
      setToken(res.token ?? "")
    } catch (e) {
      setError(e instanceof Error ? e.message : intl.formatMessage({ id: "common.saveFailed", defaultMessage: "Failed to save" }))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.integrationGithubDelete()
      setConfigured(false)
      setLogin("")
      setToken("")
    } catch (e) {
      setError(e instanceof Error ? e.message : intl.formatMessage({ id: "settings.deleteFailed", defaultMessage: "Failed to delete" }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-5 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <GithubIcon className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold mb-1"><FormattedMessage id="settings.github.title" defaultMessage="Personal access token" /></h2>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage id="settings.github.desc" defaultMessage="Only used by the manual Create PR button in the chat. Task pull requests use the GitHub App above." />
          </p>
        </div>
        {configured && login && (
          <div className="flex items-center gap-1.5 text-xs text-status-ok">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {login}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <FormattedMessage id="common.loading" defaultMessage="Loading…" />
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">
              <FormattedMessage id="settings.github.patLabel" defaultMessage="Personal Access Token" />
            </label>
            <div className="relative">
              <input
                className={tokenCn}
                type={revealed ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={intl.formatMessage({ id: "settings.github.patPlaceholder", defaultMessage: "ghp_… or github_pat_…" })}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground/60">
              <FormattedMessage
                id="settings.github.patHint"
                defaultMessage="Needs <code>repo</code> scope (classic PAT) or Pull request + Contents write (fine-grained)."
                values={{ code: (chunks) => <code className="text-[11px]">{chunks}</code> }}
              />
            </p>
          </div>

          {error && <div className="flex items-center gap-2 text-xs text-destructive">{error}</div>}

          <div className="flex items-center gap-2 pt-3 border-t border-border/40">
            <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={handleSave} disabled={saving || !token.trim()}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {configured
                ? <FormattedMessage id="settings.update" defaultMessage="Update" />
                : <FormattedMessage id="settings.connect" defaultMessage="Connect" />}
            </Button>
            {configured && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDelete}
                disabled={saving}
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <FormattedMessage id="settings.disconnect" defaultMessage="Disconnect" />
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
