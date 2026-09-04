import { useCallback, useEffect, useState } from "react"
import { FormattedMessage } from "react-intl"
import { CheckCircle2, KeyRound, Loader2, AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api, type AntigravityAuthStatus as Status } from "@/lib/api"

/**
 * Sign-in readiness for Antigravity.
 *
 * The point of showing this at all: the ACP server authenticates itself, and
 * with no credentials it opens a Google sign-in page from inside the first
 * message of a chat. Surfacing the state here turns that into something the
 * user chose, rather than a browser window appearing mid-conversation.
 */
export function AntigravityAuthStatus() {
    const [status, setStatus] = useState<Status | null>(null)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        try {
            setStatus(await api.antigravityAuthStatus())
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const chooseGoogle = async () => {
        setSaving(true)
        setError(null)
        try {
            setStatus(await api.antigravityAuthSet("oauth-personal"))
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setSaving(false)
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
    if (!status) return null

    return (
        <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
            <div className="flex items-start gap-3">
                <KeyRound className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                    <h2 className="text-sm font-semibold mb-1">
                        <FormattedMessage id="settings.antigravity.auth.title" defaultMessage="Sign-in" />
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.antigravity.auth.desc"
                            defaultMessage="Antigravity signs in on its own. Operon checks it here so a Google login page never appears in the middle of a conversation."
                        />
                    </p>
                </div>
                {status.state === "ready" && (
                    <div className="flex items-center gap-1.5 text-xs text-status-ok">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <FormattedMessage id="settings.antigravity.auth.ready" defaultMessage="Ready" />
                    </div>
                )}
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground rounded-lg bg-background/40 border border-border/40 p-3">
                <span><FormattedMessage id="settings.antigravity.auth.method" defaultMessage="Method" /></span>
                <span className="font-mono">{status.authType ?? "—"}</span>
                <span><FormattedMessage id="settings.antigravity.auth.settings" defaultMessage="Settings file" /></span>
                <span className="font-mono break-all">{status.settingsPath}</span>
            </div>

            {status.detail && status.state !== "ready" && (
                <div
                    className={
                        status.state === "needs-login"
                            ? "flex items-start gap-2 text-xs text-status-warn"
                            : "flex items-start gap-2 text-xs text-destructive"
                    }
                >
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{status.detail}</span>
                </div>
            )}

            {status.state === "not-configured" && (
                <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.antigravity.auth.chooseHint"
                            defaultMessage="Choosing Google account writes {file}. For an API key or a Gemini Enterprise account, edit that file yourself."
                            values={{ file: <span className="font-mono">{status.settingsPath}</span> }}
                        />
                    </p>
                    <Button size="sm" variant="secondary" className="h-8 gap-1.5" onClick={chooseGoogle} disabled={saving}>
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                        <FormattedMessage id="settings.antigravity.auth.useGoogle" defaultMessage="Use Google account" />
                    </Button>
                </div>
            )}

            {status.state !== "not-configured" && (
                <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => void refresh()}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    <FormattedMessage id="settings.antigravity.auth.recheck" defaultMessage="Check again" />
                </Button>
            )}

            {error && <div className="flex items-center gap-2 text-xs text-destructive">{error}</div>}
        </section>
    )
}
