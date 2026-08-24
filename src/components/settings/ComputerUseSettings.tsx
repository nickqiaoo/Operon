import { useCallback, useEffect, useState } from "react"
import {
    AlertCircle,
    CheckCircle2,
    ExternalLink,
    Loader2,
    MonitorCog,
    RefreshCw,
    ShieldAlert,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { alertMissingComputerUsePermissions } from "@/hooks/useComputerUsePermissionAlert"
import { FormattedMessage } from "react-intl"

type PermissionKind = "accessibility" | "screenRecording"

interface PermissionState {
    running: boolean
    accessibility: boolean
    screenRecording: boolean
}

const PERMISSION_ROWS: Array<{
    kind: PermissionKind
    title: string
    description: string
}> = [
    {
        kind: "accessibility",
        title: "Accessibility",
        description: "Read app interfaces and send clicks and keystrokes.",
    },
    {
        kind: "screenRecording",
        title: "Screen & System Audio Recording",
        description: "Take app screenshots and show the live preview window.",
    },
]

/**
 * Computer Use settings — one switch.
 *
 * ## Why this tab is so much emptier than Browser
 * Browser Use keeps a durable approval store on disk (`~/.operon/browser/`, written by
 * the vendored browser-client), so that tab has real state to manage: approved origins,
 * full CDP access. Computer Use approves *apps* through an in-conversation elicitation
 * (`computer.get_app_policy`), decided by the user at the moment it happens and not persisted
 * anywhere we can read back. So there is genuinely nothing else to show, and inventing
 * filler here would only imply controls that do not exist.
 */
export function ComputerUseSettings() {
    const [enabled, setEnabled] = useState<boolean | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [permissions, setPermissions] = useState<PermissionState | null>(null)
    const [permissionsBusy, setPermissionsBusy] = useState(false)

    const load = useCallback(async () => {
        setError(null)
        try {
            setEnabled((await api.computerUseGetSettings()).enabled)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }, [])

    /**
     * Grants belong to the native engine process, so this asks it rather than
     * guessing from the browser — and starts it if Computer Use is on but idle.
     */
    const loadPermissions = useCallback(async () => {
        setPermissionsBusy(true)
        try {
            const next = await api.computerUseGetPermissions()
            setPermissions(
                next.enabled
                    ? {
                          running: next.running,
                          accessibility: next.accessibility,
                          screenRecording: next.screenRecording,
                      }
                    : null,
            )
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setPermissionsBusy(false)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    useEffect(() => {
        if (enabled) void loadPermissions()
        else setPermissions(null)
    }, [enabled, loadPermissions])

    const toggle = async (next: boolean) => {
        setBusy(true)
        setError(null)
        try {
            await api.computerUseSetEnabled(next)
            setEnabled(next)
            // First-run nudge: don't wait for the user to notice the red rows below —
            // if enabling left a grant missing, surface it (the engine starts on the
            // permission read). Screenshots/AX silently no-op without these.
            if (next) void alertMissingComputerUsePermissions()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    const openPermission = async (permission: PermissionKind) => {
        try {
            await api.computerUseOpenPermissionSettings(permission)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }

    if (enabled === null && error === null) {
        return (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <FormattedMessage id="settings.computerUse.loading" defaultMessage="Loading…" />
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
                    <MonitorCog className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                        <h2 className="text-sm font-semibold mb-1">
                            <FormattedMessage id="settings.computerUse.enabled.title" defaultMessage="Computer Use" />
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            <FormattedMessage
                                id="settings.computerUse.enabled.desc"
                                defaultMessage="Let agents operate local Mac apps — read a window and click, type, scroll and press keys in it. Turning this on installs the Computer Use skill for your agents and starts the native engine; turning it off removes the skill and stops it."
                            />
                        </p>
                    </div>
                    <Switch checked={enabled ?? false} disabled={busy} onCheckedChange={(v) => void toggle(v)} />
                </div>

                {enabled ? (
                    <div className="rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.computerUse.enabled.on"
                            defaultMessage="Agents ask before operating an app for the first time, and confirm again before actions with real consequences. Approvals are per conversation — nothing is remembered here."
                        />
                    </div>
                ) : (
                    <div className="rounded-lg border border-dashed border-border/50 p-6 text-center text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.computerUse.enabled.off"
                            defaultMessage="Agents cannot see or operate your apps."
                        />
                    </div>
                )}
            </section>

            {enabled && (
                <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                    <div className="flex items-start gap-3">
                        <ShieldAlert className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="flex-1">
                            <h2 className="text-sm font-semibold mb-1">
                                <FormattedMessage
                                    id="settings.computerUse.permissions.title"
                                    defaultMessage="System permissions"
                                />
                            </h2>
                            <p className="text-xs text-muted-foreground">
                                <FormattedMessage
                                    id="settings.computerUse.permissions.desc"
                                    defaultMessage="macOS grants these to the native engine. Without Screen Recording there is no live preview and no screenshots — rebuilding or moving the app can silently revoke it."
                                />
                            </p>
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1.5 text-xs"
                            disabled={permissionsBusy}
                            onClick={() => void loadPermissions()}
                        >
                            {permissionsBusy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                            )}
                            <FormattedMessage
                                id="settings.computerUse.permissions.refresh"
                                defaultMessage="Refresh"
                            />
                        </Button>
                    </div>

                    {permissions == null ? (
                        <div className="rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
                            {permissionsBusy ? (
                                <FormattedMessage
                                    id="settings.computerUse.permissions.checking"
                                    defaultMessage="Checking…"
                                />
                            ) : (
                                <FormattedMessage
                                    id="settings.computerUse.permissions.unknown"
                                    defaultMessage="Permission status is unavailable — the native engine is not running."
                                />
                            )}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {PERMISSION_ROWS.map((row) => {
                                const granted = permissions[row.kind]
                                return (
                                    <div
                                        key={row.kind}
                                        className="flex items-center gap-3 rounded-lg border border-border/40 bg-background/40 p-3"
                                    >
                                        {granted ? (
                                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                                        ) : (
                                            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
                                        )}
                                        <div className="min-w-0 flex-1">
                                            <div className="text-xs font-medium">{row.title}</div>
                                            <div className="text-xs text-muted-foreground">
                                                {granted ? "Granted" : row.description}
                                            </div>
                                        </div>
                                        {!granted && (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                className="h-8 gap-1.5"
                                                onClick={() => void openPermission(row.kind)}
                                            >
                                                <ExternalLink className="h-3.5 w-3.5" />
                                                <FormattedMessage
                                                    id="settings.computerUse.permissions.open"
                                                    defaultMessage="Open Settings"
                                                />
                                            </Button>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </section>
            )}
        </div>
    )
}
