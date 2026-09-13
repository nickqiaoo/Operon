import { useCallback, useEffect, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Bot, CheckCircle2, Copy, Link2, Loader2, RefreshCw, Trash2, Unlink, UserRound } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api } from "@/lib/api"
import { runIntegrationFlow } from "@/lib/integration-flow"
import { LinearIcon } from "@/components/icons/LinearIcon"
import type { Agent } from "@/types/channel"
import type { GithubCoverageProject, IntegrationAppStatus, LinearDelegationConfig, LinearInstallView } from "@/types/integrations"

// Settings → Linear (docs/linear-github/design.md §13). The workspace agent is
// installed once per workspace by an admin; every member then links their own
// Linear account so delegations route to their machine. Which repository an
// issue is about is said on the issue itself (a `repo:owner/name` label), so
// the only local setting is which agent runs a delegation. No token lives
// here — the broker holds the app token and proxies every Linear call.

const NONE = "__none__"

export function LinearSettings() {
  const intl = useIntl()
  const [status, setStatus] = useState<IntegrationAppStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await api.integrationAppStatus()
      setStatus(res)
      setError(res.brokerError ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : intl.formatMessage({ id: "settings.loadFailed", defaultMessage: "Failed to load" }))
    } finally {
      setLoading(false)
    }
  }, [intl])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runFlow = async (kind: "linear/install" | "linear/link") => {
    setBusy(kind)
    setError(null)
    try {
      const next = await runIntegrationFlow(kind, () =>
        kind === "linear/install" ? api.integrationLinearInstall() : api.integrationLinearLink(),
      )
      setStatus(next)
      setError(next.brokerError ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authorization failed")
    } finally {
      setBusy(null)
    }
  }

  const unlink = async (orgId: string) => {
    setBusy("unlink")
    setError(null)
    try {
      const res = await api.integrationLinearUnlink(orgId)
      if (res.error) setError(res.error)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const uninstall = async (orgId: string) => {
    setBusy("uninstall")
    setError(null)
    try {
      const res = await api.integrationLinearUninstall(orgId)
      if (res.error) setError(res.error)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        <FormattedMessage id="common.loading" defaultMessage="Loading…" />
      </div>
    )
  }

  const saasConnected = status?.saasConnected ?? false
  const installs = (status?.linear.installs ?? []).filter((i) => !i.revoked)
  const local = status?.linear.local ?? null
  const install: LinearInstallView | undefined =
    installs.find((i) => i.orgId === local?.orgId) ?? installs[0]
  const linked = !!local?.linearUserId

  return (
    <div className="space-y-6">
      {!saasConnected && (
        <div className="rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
          <FormattedMessage
            id="settings.linear.signInFirst"
            defaultMessage="Sign in on the Remote tab first. The Linear agent is installed through your operon account."
          />
        </div>
      )}

      {error && <div className="flex items-center gap-2 text-xs text-destructive">{error}</div>}

      {/* Card 1: the workspace agent (once per workspace, admin) */}
      <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
        <div className="flex items-start gap-3">
          <LinearIcon className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1">
            <h2 className="text-sm font-semibold mb-1">
              <FormattedMessage id="settings.linear.agent.title" defaultMessage="Workspace agent" />
            </h2>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.linear.agent.desc"
                defaultMessage="The operon agent is installed once per Linear workspace. Everyone on the workspace can then delegate issues to it."
              />
            </p>
          </div>
          {install && (
            <div className="flex items-center gap-1.5 text-xs text-status-ok">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <FormattedMessage id="settings.linear.agent.installed" defaultMessage="Installed" />
            </div>
          )}
        </div>

        {install ? (
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground rounded-lg bg-background/40 border border-border/40 p-3">
            <span><FormattedMessage id="settings.linear.agent.workspace" defaultMessage="Workspace" /></span>
            <span className="text-foreground/80">{install.workspaceName || install.urlKey}</span>
            <span><FormattedMessage id="settings.linear.agent.name" defaultMessage="Agent" /></span>
            <span className="text-foreground/80">{install.appUserName || "operon"}</span>
            <span><FormattedMessage id="settings.linear.agent.installedBy" defaultMessage="Installed by" /></span>
            <span className="text-foreground/80">
              {install.installedByMe
                ? intl.formatMessage({ id: "settings.linear.agent.you", defaultMessage: "You" })
                : intl.formatMessage({ id: "settings.linear.agent.teammate", defaultMessage: "A teammate" })}
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/70">
            <FormattedMessage
              id="settings.linear.agent.notInstalled"
              defaultMessage="Not installed in any workspace you belong to yet."
            />
          </p>
        )}

        <div className="flex items-center gap-2">
          {!install || install.installedByMe ? (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              disabled={!saasConnected || busy !== null}
              onClick={() => void runFlow("linear/install")}
            >
              {busy === "linear/install" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {install
                ? <FormattedMessage id="settings.linear.agent.reinstall" defaultMessage="Reinstall" />
                : <FormattedMessage id="settings.linear.agent.install" defaultMessage="Install operon agent" />}
            </Button>
          ) : null}
          {install?.installedByMe && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
              disabled={busy !== null}
              onClick={() => void uninstall(install.orgId)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <FormattedMessage id="settings.linear.agent.uninstall" defaultMessage="Uninstall" />
            </Button>
          )}
          {!install && (
            <span className="text-[11px] text-muted-foreground/60">
              <FormattedMessage id="settings.linear.agent.adminHint" defaultMessage="Requires a Linear workspace admin" />
            </span>
          )}
        </div>
      </section>

      {/* Card 2: this member's Linear identity */}
      <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
        <div className="flex items-start gap-3">
          <UserRound className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1">
            <h2 className="text-sm font-semibold mb-1">
              <FormattedMessage id="settings.linear.account.title" defaultMessage="My Linear account" />
            </h2>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.linear.account.desc"
                defaultMessage="Delegations you make in Linear will run on this machine. Linking does not install anything and needs no admin."
              />
            </p>
          </div>
          {linked && (
            <div className="flex items-center gap-1.5 text-xs text-status-ok">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {local?.linearUserName ?? intl.formatMessage({ id: "settings.linear.account.linked", defaultMessage: "Linked" })}
            </div>
          )}
        </div>

        {linked && local && (
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground rounded-lg bg-background/40 border border-border/40 p-3">
            <span><FormattedMessage id="settings.linear.account.user" defaultMessage="Linear user" /></span>
            <span className="text-foreground/80">{local.linearUserName ?? local.linearUserId}</span>
            <span><FormattedMessage id="settings.linear.account.workspace" defaultMessage="Workspace" /></span>
            <span className="text-foreground/80">{local.orgName || local.urlKey}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5"
            disabled={!saasConnected || busy !== null}
            onClick={() => void runFlow("linear/link")}
          >
            {busy === "linear/link" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
            {linked
              ? <FormattedMessage id="settings.linear.account.relink" defaultMessage="Relink" />
              : <FormattedMessage id="settings.linear.account.link" defaultMessage="Link my Linear account" />}
          </Button>
          {linked && local && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
              disabled={busy !== null}
              onClick={() => void unlink(local.orgId)}
            >
              <Unlink className="h-3.5 w-3.5" />
              <FormattedMessage id="settings.linear.account.unlink" defaultMessage="Unlink" />
            </Button>
          )}
        </div>
      </section>

      {/* Card 3: how a delegation starts on this machine */}
      <DelegationCard
        enabled={saasConnected && !!local}
        config={status?.delegation ?? { defaultAgentId: null }}
        onChanged={(delegation) => setStatus((s) => (s ? { ...s, delegation } : s))}
      />
    </div>
  )
}

function DelegationCard({
  enabled,
  config,
  onChanged,
}: {
  enabled: boolean
  config: LinearDelegationConfig
  onChanged: (config: LinearDelegationConfig) => void
}) {
  const intl = useIntl()
  const [agents, setAgents] = useState<Agent[]>([])
  const [projects, setProjects] = useState<GithubCoverageProject[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    ;(async () => {
      try {
        const [a, c] = await Promise.all([api.agentList(), api.integrationGithubCoverage()])
        if (cancelled) return
        setAgents(a.agents)
        setProjects(c.projects)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  const save = async (defaultAgentId: number | null) => {
    setSaving(true)
    setError(null)
    try {
      const res = await api.integrationLinearDelegationSave({ defaultAgentId })
      onChanged(res.delegation)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const copyLabel = async (label: string) => {
    try {
      await navigator.clipboard.writeText(label)
      toast.success(intl.formatMessage({ id: "settings.linear.delegation.copied", defaultMessage: "Copied {label}" }, { label }))
    } catch {
      // Clipboard can be unavailable in a webview; the text is still visible to select.
    }
  }

  const withRepo = projects.filter((p) => p.repo)

  return (
    <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <Bot className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold mb-1">
            <FormattedMessage id="settings.linear.delegation.title" defaultMessage="Delegations from Linear" />
          </h2>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.linear.delegation.desc"
              defaultMessage="An issue you delegate to the agent starts here only when it carries a repo label naming a repository that is open in operon on this machine. Without one, nothing runs and the session says why."
            />
          </p>
        </div>
      </div>

      {!enabled ? (
        <p className="text-xs text-muted-foreground/70">
          <FormattedMessage id="settings.linear.delegation.linkFirst" defaultMessage="Link your Linear account first." />
        </p>
      ) : (
        <>
          {error && <div className="flex items-center gap-2 text-xs text-destructive">{error}</div>}

          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground w-24 shrink-0">
              <FormattedMessage id="settings.linear.delegation.agent" defaultMessage="Run with" />
            </span>
            <Select
              value={config.defaultAgentId != null ? String(config.defaultAgentId) : NONE}
              onValueChange={(v) => void save(v === NONE ? null : Number(v))}
              disabled={saving}
            >
              <SelectTrigger className="h-8 w-56 border-border/50 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  {intl.formatMessage({ id: "settings.linear.delegation.noAgent", defaultMessage: "Nobody — wait for me to start it" })}
                </SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>

          <div className="rounded-lg bg-background/40 border border-border/40 p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.linear.delegation.labelsHint"
                defaultMessage="Labels to put on issues, one per repository open here:"
              />
            </p>
            {withRepo.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">
                <FormattedMessage
                  id="settings.linear.delegation.noRepos"
                  defaultMessage="No project open here has a GitHub remote yet."
                />
              </p>
            ) : (
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                {withRepo.map((p) => {
                  const label = `repo:${p.repo}`
                  return (
                    <div key={p.projectId} className="contents">
                      <span className="text-muted-foreground truncate">{p.name}</span>
                      <button
                        type="button"
                        className="group inline-flex items-center gap-1.5 justify-self-start font-mono text-foreground/80 hover:text-foreground"
                        onClick={() => void copyLabel(label)}
                        title={intl.formatMessage({ id: "settings.linear.delegation.copy", defaultMessage: "Copy" })}
                      >
                        {label}
                        <Copy className="h-3 w-3 text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
