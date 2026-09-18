import { useCallback, useEffect, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Loader2, CheckCircle2, Trash2, Link2, ExternalLink, XCircle, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { runIntegrationFlow } from "@/lib/integration-flow"
import { isMacPlatform } from "@/lib/shortcuts/accelerator"
import { openExternalUrl } from "@/lib/open-external"
import { GithubIcon } from "@/components/icons/GithubIcon"
import type { GithubCoverageProject, IntegrationAppStatus } from "@/types/integrations"

export function GithubSettings() {
  return (
    <div className="space-y-6">
      <GithubAppCard />
      <GithubCliCard />
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

/**
 * PRs opened from the review toolbar run through the user's own `gh` login, so
 * there is no token to enter here. This card exists to answer the one question
 * that replaced it: why is "Create Pull Request" greyed out?
 */
function GithubCliCard() {
  const intl = useIntl()
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<{ isInstalled: boolean; isAuthenticated: boolean } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.integrationGithubCliStatus())
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : intl.formatMessage({ id: "settings.loadFailed", defaultMessage: "Failed to load" }),
      )
    } finally {
      setLoading(false)
    }
  }, [intl])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <GithubIcon className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold mb-1">
            <FormattedMessage id="settings.github.cli.title" defaultMessage="GitHub CLI" />
          </h2>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.github.cli.desc"
              defaultMessage="Pull requests you open from the review toolbar are authored with your own gh login — the same one your terminal uses. Nothing is stored in operon."
            />
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <FormattedMessage id="common.loading" defaultMessage="Loading…" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-xs text-destructive">{error}</div>
      ) : (
        <>
          {status?.isAuthenticated ? (
            <div className="flex items-center gap-2 text-sm text-status-ok">
              <CheckCircle2 className="h-4 w-4" />
              <FormattedMessage id="settings.github.cli.ready" defaultMessage="Signed in" />
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <XCircle className="h-4 w-4" />
                {status?.isInstalled ? (
                  <FormattedMessage
                    id="settings.github.cli.notSignedIn"
                    defaultMessage="Not signed in"
                  />
                ) : (
                  <FormattedMessage
                    id="settings.github.cli.notInstalled"
                    defaultMessage="Not installed"
                  />
                )}
              </div>
              <code className="block rounded-lg border border-border/40 bg-background/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                {status?.isInstalled
                  ? "gh auth login"
                  : isMacPlatform()
                    ? "brew install gh && gh auth login"
                    : "gh auth login"}
              </code>
              {!status?.isInstalled && !isMacPlatform() && (
                <p className="text-xs text-muted-foreground">
                  <FormattedMessage
                    id="settings.github.cli.installHint"
                    defaultMessage="Install it from cli.github.com first."
                  />
                </p>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void load()}
              className="h-7 gap-1.5 text-xs"
            >
              <FormattedMessage id="common.refresh" defaultMessage="Refresh" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openExternalUrl("https://cli.github.com")}
              className="h-7 gap-1.5 text-xs text-muted-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              cli.github.com
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
