import { useEffect, useState } from "react"
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { LinearIcon } from "@/components/icons/LinearIcon"
import { FormattedMessage, useIntl } from "react-intl"

// Outbound only. The inbound Linear Agent integration was retired in favour
// of the built-in task system; its server code still lives under
// server/src/gateway/linear/ but no UI mounts it and the runtime is no longer
// started. See CHANGELOG.
//
// What remains is the personal API key used to push work OUT to Linear
// (LinearShareDialog → /api/integrations/linear/*), which talks to Linear's
// GraphQL API directly.

const tokenCn =
  "w-full px-3 py-2 text-sm bg-muted/30 rounded-xl border border-transparent hover:bg-muted/50 focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40 transition-colors font-mono pr-10"

export function LinearSettings() {
    return (
        <div className="space-y-6">
            <LinearApiKeyCard />
        </div>
    )
}

function LinearApiKeyCard() {
    const intl = useIntl()
    const [loading, setLoading] = useState(true)
    const [configured, setConfigured] = useState(false)
    const [workspaceName, setWorkspaceName] = useState("")
    const [apiKey, setApiKey] = useState("")
    const [revealed, setRevealed] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        ;(async () => {
            try {
                const res = await api.integrationLinearGet()
                if (cancelled) return
                setConfigured(Boolean(res.configured))
                setWorkspaceName(res.workspaceName ?? "")
                setApiKey(res.apiKey ?? "")
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : intl.formatMessage({ id: "settings.linear.apiKey.failedLoad", defaultMessage: "Failed to load" }))
            } finally {
                if (!cancelled) setLoading(false)
            }
        })()
        return () => {
            cancelled = true
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const handleSave = async () => {
        if (!apiKey.trim()) return
        setSaving(true)
        setError(null)
        try {
            const res = (await api.integrationLinearSave(apiKey.trim())) as {
                configured?: boolean
                apiKey?: string
                workspaceName?: string
                error?: string
            }
            if (res.error || !res.configured) {
                setError(res.error ?? intl.formatMessage({ id: "settings.linear.apiKey.failedSave", defaultMessage: "Failed to save" }))
                return
            }
            setConfigured(res.configured)
            setWorkspaceName(res.workspaceName ?? "")
            setApiKey(res.apiKey ?? "")
        } catch (e) {
            setError(e instanceof Error ? e.message : intl.formatMessage({ id: "settings.linear.apiKey.failedSave", defaultMessage: "Failed to save" }))
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async () => {
        setSaving(true)
        setError(null)
        try {
            await api.integrationLinearDelete()
            setConfigured(false)
            setWorkspaceName("")
            setApiKey("")
        } catch (e) {
            setError(e instanceof Error ? e.message : intl.formatMessage({ id: "settings.linear.apiKey.failedDelete", defaultMessage: "Failed to delete" }))
        } finally {
            setSaving(false)
        }
    }

    return (
        <section className="space-y-5 rounded-xl border border-border/40 bg-muted/10 p-5">
            <div className="flex items-start gap-3">
                <LinearIcon className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                    <h2 className="text-sm font-semibold mb-1">
                        <FormattedMessage id="settings.linear.apiKey.title" defaultMessage="Personal API Key" />
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        <FormattedMessage id="settings.linear.apiKey.desc" defaultMessage="Share assistant messages as Linear issues." />
                    </p>
                </div>
                {configured && workspaceName && (
                    <div className="flex items-center gap-1.5 text-xs text-status-ok">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {workspaceName}
                    </div>
                )}
            </div>

            {loading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <FormattedMessage id="settings.linear.loading" defaultMessage="Loading…" />
                </div>
            ) : (
                <>
                    <div className="space-y-1.5">
                        <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">
                            <FormattedMessage id="settings.linear.apiKey.label" defaultMessage="Personal API Key" />
                        </label>
                        <div className="relative">
                            <input
                                className={tokenCn}
                                type={revealed ? "text" : "password"}
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="lin_api_…"
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
                            <FormattedMessage id="settings.linear.apiKey.hint" defaultMessage="Create a key at Linear → Settings → API → Personal API keys." />
                        </p>
                    </div>

                    {error && <div className="text-xs text-destructive">{error}</div>}

                    <div className="flex items-center gap-2 pt-3 border-t border-border/40">
                        <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={handleSave} disabled={saving || !apiKey.trim()}>
                            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                            {configured
                                ? <FormattedMessage id="settings.linear.apiKey.update" defaultMessage="Update" />
                                : <FormattedMessage id="settings.linear.apiKey.connect" defaultMessage="Connect" />
                            }
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
                                <FormattedMessage id="settings.linear.apiKey.disconnect" defaultMessage="Disconnect" />
                            </Button>
                        )}
                    </div>
                </>
            )}
        </section>
    )
}
