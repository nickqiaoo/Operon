import { useCallback, useEffect, useRef, useState } from "react"
import { FormattedMessage } from "react-intl"
import { Download, Loader2, CheckCircle2, Trash2, PackageOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { api, type AcpAgentEntry } from "@/lib/api"

/** A busy install is worth re-polling; a finished one is not. */
const RUNNING: ReadonlyArray<string> = ["downloading", "extracting", "installing"]

function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 MB"
    const mb = bytes / (1024 * 1024)
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

/**
 * Install/remove an ACP agent that ships as a downloadable binary.
 *
 * Polls rather than streams: the whole job is one long download whose only
 * interesting state is a byte count, and the server already keeps that. A
 * one-second poll costs nothing next to a ~316MB transfer.
 */
export function AcpAgentInstaller({ agentId }: { agentId: string }) {
    const [entry, setEntry] = useState<AcpAgentEntry | null>(null)
    const [loading, setLoading] = useState(true)
    const [actionError, setActionError] = useState<string | null>(null)
    // Kept in a ref so the poll effect doesn't restart on every tick.
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const refresh = useCallback(async () => {
        try {
            const { agents } = await api.acpAgentsList()
            setEntry(agents.find((a) => a.id === agentId) ?? null)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        } finally {
            setLoading(false)
        }
    }, [agentId])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const running = entry ? RUNNING.includes(entry.progress.state) : false

    // Poll only while something is actually happening, and stop as soon as it
    // isn't — an idle Settings tab should not talk to the server every second.
    useEffect(() => {
        if (!running) {
            if (pollRef.current) {
                clearInterval(pollRef.current)
                pollRef.current = null
            }
            return
        }
        pollRef.current = setInterval(() => void refresh(), 1000)
        return () => {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
        }
    }, [running, refresh])

    const install = async () => {
        setActionError(null)
        try {
            const result = await api.acpAgentInstall(agentId)
            if (result.error) setActionError(result.error)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        }
        await refresh()
    }

    const uninstall = async () => {
        setActionError(null)
        try {
            await api.acpAgentUninstall(agentId)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
        }
        await refresh()
    }

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <FormattedMessage id="common.loading" defaultMessage="Loading…" />
            </div>
        )
    }
    if (!entry) return null

    const { progress, installed } = entry
    // Clamped: the bytes off the wire can exceed Content-Length (a chunked or
    // re-encoded response), and an unclamped bar overshoots its track.
    const pct = progress.totalBytes > 0
        ? Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)
        : 0

    return (
        <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
            <div className="flex items-start gap-3">
                <PackageOpen className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                    <h2 className="text-sm font-semibold mb-1">
                        <FormattedMessage id="settings.acpAgent.title" defaultMessage="ACP Server" />
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.acpAgent.desc"
                            defaultMessage="Download the ACP server from the official registry. About 316MB to download and 886MB on disk."
                        />
                    </p>
                </div>
                {installed && !running && (
                    <div className="flex items-center gap-1.5 text-xs text-status-ok">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        v{installed.version}
                    </div>
                )}
            </div>

            {!entry.supported && (
                <div className="flex items-center gap-2 text-xs text-destructive">
                    <FormattedMessage
                        id="settings.acpAgent.unsupported"
                        defaultMessage="The registry has no build for this machine. You can still point Operon at a server you installed yourself."
                    />
                </div>
            )}

            {installed && (
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground rounded-lg bg-background/40 border border-border/40 p-3">
                    <span><FormattedMessage id="settings.acpAgent.location" defaultMessage="Location" /></span>
                    <span className="font-mono break-all">{entry.resolvedPath ?? "—"}</span>
                </div>
            )}

            {running && (
                <div className="space-y-2">
                    <Progress value={progress.state === "downloading" ? pct : 100} className="h-1.5" />
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {progress.state === "downloading" ? (
                            <FormattedMessage
                                id="settings.acpAgent.downloading"
                                defaultMessage="Downloading… {received} of {total}"
                                values={{
                                    received: formatBytes(progress.receivedBytes),
                                    total: progress.totalBytes > 0 ? formatBytes(progress.totalBytes) : "?",
                                }}
                            />
                        ) : progress.state === "extracting" ? (
                            <FormattedMessage id="settings.acpAgent.extracting" defaultMessage="Unpacking…" />
                        ) : (
                            <FormattedMessage id="settings.acpAgent.installing" defaultMessage="Installing…" />
                        )}
                    </div>
                </div>
            )}

            {progress.state === "error" && progress.error && (
                <div className="flex items-center gap-2 text-xs text-destructive">{progress.error}</div>
            )}
            {actionError && <div className="flex items-center gap-2 text-xs text-destructive">{actionError}</div>}

            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 gap-1.5"
                    onClick={install}
                    disabled={running || !entry.supported}
                >
                    {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    {installed ? (
                        <FormattedMessage id="settings.acpAgent.reinstall" defaultMessage="Reinstall" />
                    ) : (
                        <FormattedMessage id="settings.acpAgent.install" defaultMessage="Install" />
                    )}
                </Button>
                {installed && !running && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={uninstall}>
                        <Trash2 className="h-3.5 w-3.5" />
                        <FormattedMessage id="settings.acpAgent.remove" defaultMessage="Remove" />
                    </Button>
                )}
            </div>
        </section>
    )
}
