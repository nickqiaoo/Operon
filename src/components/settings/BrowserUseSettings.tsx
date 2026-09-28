import { useCallback, useEffect, useState } from "react"
import { AlertCircle, AppWindow, Loader2 } from "lucide-react"
import { FormattedMessage } from "react-intl"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"

export function BrowserUseSettings() {
    const [enabled, setEnabled] = useState(false)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            setEnabled((await api.browserUseGetApprovals()).enabled)
            setError(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void load() }, [load])

    const toggle = async (next: boolean) => {
        setBusy(true)
        try {
            await api.browserUseSetEnabled(next)
            await load()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /><FormattedMessage id="settings.browserUse.loading" defaultMessage="Loading…" /></div>

    return (
        <div className="space-y-4">
            {error && <div className="flex items-center gap-2 text-xs text-destructive"><AlertCircle className="size-4" />{error}</div>}
            <section className="rounded-xl border border-border/40 bg-muted/10 p-5">
                <div className="flex items-start gap-3">
                    <AppWindow className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="flex-1">
                        <h2 className="mb-1 text-sm font-semibold"><FormattedMessage id="settings.browserUse.enabled.title" defaultMessage="Browser Use" /></h2>
                        <p className="text-xs text-muted-foreground"><FormattedMessage id="settings.browserUse.enabled.desc" defaultMessage="Let agents drive the built-in browser — open pages, click, type and read what they see. Turning this on installs the Browser skill for your agents; turning it off removes it again." /></p>
                    </div>
                    <Switch checked={enabled} disabled={busy} onCheckedChange={(next) => void toggle(next)} />
                </div>
                {!enabled && <p className="mt-4 rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground"><FormattedMessage id="settings.browserUse.enabled.off" defaultMessage="Agents cannot see the browser. Sites you approved before are kept and apply again once you turn this back on." /></p>}
            </section>
        </div>
    )
}
