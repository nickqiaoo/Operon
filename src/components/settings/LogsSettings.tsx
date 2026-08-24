import { cn } from "@/lib/utils"
import { FolderOpen, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { FormattedMessage } from "react-intl"
import { Switch } from "@/components/ui/switch"

export function LogsSettings() {
    const [logEnabled, setLogEnabled] = useState(false)
    const [logPath, setLogPath] = useState("")
    const [logContent, setLogContent] = useState<string | null>(null)
    const [logLoading, setLogLoading] = useState(false)
    const logEndRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        window.electronAPI?.getLogging?.().then(({ enabled, path }) => {
            setLogEnabled(enabled)
            setLogPath(path)
        })
    }, [])

    const loadLog = useCallback(async () => {
        setLogLoading(true)
        const content = await window.electronAPI?.readLogTail?.() ?? ""
        setLogContent(content)
        setLogLoading(false)
        setTimeout(() => logEndRef.current?.scrollIntoView(), 50)
    }, [])

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between pb-6 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.logs.title" defaultMessage="Debug Logging" /></div>
                    <div className="text-sm text-muted-foreground">
                        <FormattedMessage id="settings.logs.desc" defaultMessage="Write logs to file for troubleshooting (max 10 MB, auto-rotated)" />
                    </div>
                    {logPath && (
                        <div className="text-xs text-muted-foreground/60 mt-1 font-mono truncate max-w-xl">
                            {logPath}
                        </div>
                    )}
                </div>
                <Switch
                    checked={logEnabled}
                    onCheckedChange={(next) => {
                        setLogEnabled(next)
                        window.electronAPI?.setLogging?.(next)
                        if (!next) setLogContent(null)
                    }}
                />
            </div>

            {logEnabled && (
                <div className="space-y-3">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={logContent === null ? loadLog : () => setLogContent(null)}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-muted hover:bg-muted/80 text-foreground transition-colors"
                        >
                            {logContent === null
                                ? <FormattedMessage id="settings.logs.view" defaultMessage="View Log" />
                                : <FormattedMessage id="settings.logs.hide" defaultMessage="Hide Log" />}
                        </button>
                        {logContent !== null && (
                            <button
                                onClick={loadLog}
                                disabled={logLoading}
                                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-muted hover:bg-muted/80 text-foreground transition-colors disabled:opacity-50"
                            >
                                <RefreshCw className={cn("size-3", logLoading && "animate-spin")} />
                                <FormattedMessage id="common.refresh" defaultMessage="Refresh" />
                            </button>
                        )}
                        <button
                            onClick={() => window.electronAPI?.revealLogFile?.()}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-muted hover:bg-muted/80 text-foreground transition-colors"
                        >
                            <FolderOpen className="size-3" />
                            <FormattedMessage id="settings.logs.reveal" defaultMessage="Reveal in Finder" />
                        </button>
                    </div>

                    {logContent !== null && (
                        <div className="relative rounded-md border border-border/60 bg-muted/30 overflow-hidden">
                            <pre className="overflow-auto max-h-96 p-3 text-[11px] leading-relaxed font-mono text-muted-foreground whitespace-pre-wrap break-all code-scrollbar">
                                {logContent || <FormattedMessage id="settings.logs.empty" defaultMessage="No log content yet." />}
                                <div ref={logEndRef} />
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
