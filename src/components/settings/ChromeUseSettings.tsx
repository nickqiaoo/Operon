import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Chrome, CheckCircle2, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { openExternalUrl } from "@/lib/open-external"
import { FormattedMessage } from "react-intl"

type Settings = Awaited<ReturnType<typeof api.chromeUseGetSettings>>

const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/detail/annipikgonognboogflchfnagmhbbipc"

/**
 * Chrome settings — one switch, plus the install state the switch cannot control.
 *
 * ## Why this tab has state the other two do not
 * Browser Use and Computer Use are entirely ours: flip the switch and the capability is
 * there. Chrome is not — it needs an extension the user installs into their own browser,
 * and we can only report on it. So "on" here does not mean "working", and the tab has to
 * show both: the switch is the user's intent, the checks below are reality.
 *
 * The checks read Chrome's own on-disk profile registry rather than trying a connection,
 * because "not installed" and "installed but the host is broken" need different advice and
 * a failed connection cannot tell them apart.
 */
export function ChromeUseSettings() {
    const [settings, setSettings] = useState<Settings | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback(async () => {
        setError(null)
        try {
            setSettings(await api.chromeUseGetSettings())
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const toggle = async (next: boolean) => {
        setBusy(true)
        setError(null)
        try {
            await api.chromeUseSetEnabled(next)
            // Refetch rather than patch `enabled` in place: turning on installs the native
            // host, so the checks below are stale the moment the switch moves.
            await load()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    const reinstallHost = async () => {
        setBusy(true)
        setError(null)
        try {
            await api.chromeUseReinstallHost()
            await load()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    if (settings === null && error === null) {
        return (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <FormattedMessage id="settings.chrome.loading" defaultMessage="Loading…" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {error && (
                <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {error}
                </div>
            )}

            <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                <div className="flex items-start gap-3">
                    <Chrome className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                        <h2 className="text-sm font-semibold mb-1">
                            <FormattedMessage id="settings.chrome.enabled.title" defaultMessage="Chrome" />
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            <FormattedMessage
                                id="settings.chrome.enabled.desc"
                                defaultMessage="Let agents drive your own Chrome — your tabs, your logins, your history. Turning this on installs the Chrome skill for your agents and registers the native host Chrome needs to reach Operon; turning it off removes both."
                            />
                        </p>
                    </div>
                    <Switch
                        checked={settings?.enabled ?? false}
                        disabled={busy}
                        onCheckedChange={(v) => void toggle(v)}
                    />
                </div>

                {settings?.enabled ? (
                    <div className="rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.chrome.enabled.on"
                            defaultMessage="Agents work in tabs they open, and ask before acting as you — sending, posting, buying, or changing account settings. For throwaway work that does not need your session, they use Operon's own browser instead."
                        />
                    </div>
                ) : (
                    <div className="rounded-lg border border-dashed border-border/50 p-6 text-center text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.chrome.enabled.off"
                            defaultMessage="Agents cannot see or drive your Chrome."
                        />
                    </div>
                )}
            </section>

            {settings?.enabled && <ChromeStatus settings={settings} busy={busy} onReinstall={() => void reinstallHost()} onRefresh={() => void load()} />}
        </div>
    )
}

function ChromeStatus({
    settings,
    busy,
    onReinstall,
    onRefresh,
}: {
    settings: Settings
    busy: boolean
    onReinstall: () => void
    onRefresh: () => void
}) {
    const profileWithExtension = settings.profiles.find((p) => p.installed && p.enabled)

    return (
        <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
            <div className="flex items-start gap-3">
                <Chrome className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                    <h2 className="text-sm font-semibold mb-1">
                        <FormattedMessage id="settings.chrome.status.title" defaultMessage="Connection" />
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.chrome.status.desc"
                            defaultMessage="Both pieces have to be in place: the extension inside Chrome, and the native host that lets Chrome reach Operon."
                        />
                    </p>
                </div>
                <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" disabled={busy} onClick={onRefresh}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    <FormattedMessage id="settings.chrome.status.refresh" defaultMessage="Refresh" />
                </Button>
            </div>

            <div className="space-y-2">
                <StatusRow
                    ok={settings.chromeInstalled}
                    label={<FormattedMessage id="settings.chrome.check.chrome" defaultMessage="Google Chrome" />}
                    detail={
                        settings.chromeInstalled ? undefined : (
                            <FormattedMessage
                                id="settings.chrome.check.chrome.missing"
                                defaultMessage="Not found on this Mac. This feature only works with Chrome."
                            />
                        )
                    }
                />
                <StatusRow
                    ok={settings.extensionInstalled}
                    label={<FormattedMessage id="settings.chrome.check.extension" defaultMessage="Operon extension" />}
                    detail={
                        settings.extensionInstalled ? (
                            profileWithExtension?.unpacked ? (
                                <FormattedMessage
                                    id="settings.chrome.check.extension.unpacked"
                                    defaultMessage="Loaded unpacked in {profile}."
                                    values={{ profile: profileWithExtension.directory }}
                                />
                            ) : (
                                <FormattedMessage
                                    id="settings.chrome.check.extension.ok"
                                    defaultMessage="Installed in {profile}."
                                    values={{ profile: profileWithExtension?.directory ?? "Default" }}
                                />
                            )
                        ) : settings.extensionDisabled ? (
                            <FormattedMessage
                                id="settings.chrome.check.extension.disabled"
                                defaultMessage="Installed but switched off. Enable it at chrome://extensions."
                            />
                        ) : (
                            <FormattedMessage
                                id="settings.chrome.check.extension.missing"
                                defaultMessage="Not installed yet. Install Operon Browser Use from the Chrome Web Store."
                            />
                        )
                    }
                    action={
                        !settings.extensionInstalled && !settings.extensionDisabled ? (
                            <Button
                                size="sm"
                                variant="secondary"
                                className="h-8 gap-1.5"
                                onClick={() => openExternalUrl(CHROME_WEB_STORE_URL)}
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                <FormattedMessage
                                    id="settings.chrome.check.extension.install"
                                    defaultMessage="Install extension"
                                />
                            </Button>
                        ) : undefined
                    }
                />
                <StatusRow
                    ok={settings.nativeHostInstalled && !settings.nativeHostStale}
                    label={<FormattedMessage id="settings.chrome.check.host" defaultMessage="Native host" />}
                    detail={
                        settings.nativeHostStale ? (
                            <FormattedMessage
                                id="settings.chrome.check.host.stale"
                                defaultMessage="Registered, but it points at an Operon that no longer exists — most likely an update moved it. Reinstall to repair."
                            />
                        ) : settings.nativeHostInstalled ? undefined : (
                            <FormattedMessage
                                id="settings.chrome.check.host.missing"
                                defaultMessage="Not registered with Chrome."
                            />
                        )
                    }
                    action={
                        settings.nativeHostStale || !settings.nativeHostInstalled ? (
                            <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={busy} onClick={onReinstall}>
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                <FormattedMessage id="settings.chrome.check.host.reinstall" defaultMessage="Reinstall" />
                            </Button>
                        ) : undefined
                    }
                />
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground rounded-lg bg-background/40 border border-border/40 p-3">
                <span>
                    <FormattedMessage id="settings.chrome.extensionId" defaultMessage="Extension ID" />
                </span>
                <span className="font-mono break-all">{settings.extensionId}</span>
            </div>
        </section>
    )
}

function StatusRow({
    ok,
    label,
    detail,
    action,
}: {
    ok: boolean
    label: React.ReactNode
    detail?: React.ReactNode
    action?: React.ReactNode
}) {
    return (
        <div className="flex items-start gap-2.5 rounded-lg border border-border/40 bg-background/40 p-3">
            {ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" />
            ) : (
                <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
            )}
            <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{label}</div>
                {detail && <div className="text-xs text-muted-foreground mt-0.5">{detail}</div>}
            </div>
            {action}
        </div>
    )
}
