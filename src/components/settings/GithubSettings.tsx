import { useEffect, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { Eye, EyeOff, Loader2, CheckCircle2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { GithubIcon } from "@/components/icons/GithubIcon"

const inputCn =
  "w-full px-3 py-2 text-sm bg-muted/30 rounded-xl border border-transparent hover:bg-muted/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40 transition-colors"

const tokenCn = inputCn + " font-mono pr-10"

export function GithubSettings() {
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
          <h2 className="text-sm font-semibold mb-1"><FormattedMessage id="settings.github.title" defaultMessage="GitHub" /></h2>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage id="settings.github.desc" defaultMessage="Personal Access Token for creating pull requests from the chat." />
          </p>
        </div>
        {configured && login && (
          <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {login}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
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

          {error && <div className="text-xs text-red-500">{error}</div>}

          <div className="flex items-center gap-2 pt-3 border-t border-border/40">
            <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={handleSave} disabled={saving || !token.trim()}>
              {saving && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
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
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                <FormattedMessage id="settings.disconnect" defaultMessage="Disconnect" />
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
