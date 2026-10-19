import { cn } from "@/lib/utils"
import { Eye, EyeOff, FileText, FolderOpen, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { FormattedMessage } from "react-intl"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SettingsSection } from "./SettingsSection"

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
        <SettingsSection
            icon={FileText}
            title={<FormattedMessage id="settings.logs.title" defaultMessage="Debug Logging" />}
            description={
                <>
                    <FormattedMessage id="settings.logs.desc" defaultMessage="Write logs to file for troubleshooting (max 10 MB, auto-rotated)" />
                    {logPath && <div className="mt-1 max-w-xl truncate font-mono text-muted-foreground/60">{logPath}</div>}
                </>
            }
            action={
                <Switch
                    checked={logEnabled}
                    onCheckedChange={(next) => {
                        setLogEnabled(next)
                        window.electronAPI?.setLogging?.(next)
                        if (!next) setLogContent(null)
                    }}
                />
            }
        >
            {logEnabled && (
                <div className="space-y-3">
                    <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={logContent === null ? loadLog : () => setLogContent(null)}>
                            {logContent === null ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                            {logContent === null
                                ? <FormattedMessage id="settings.logs.view" defaultMessage="View Log" />
                                : <FormattedMessage id="settings.logs.hide" defaultMessage="Hide Log" />}
                        </Button>
                        {logContent !== null && (
                            <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={loadLog} disabled={logLoading}>
                                <RefreshCw className={cn("h-3.5 w-3.5", logLoading && "animate-spin")} />
                                <FormattedMessage id="common.refresh" defaultMessage="Refresh" />
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => window.electronAPI?.revealLogFile?.()}>
                            <FolderOpen className="h-3.5 w-3.5" />
                            <FormattedMessage id="settings.logs.reveal" defaultMessage="Reveal in Finder" />
                        </Button>
                    </div>

                    {logContent !== null && (
                        <div className="relative overflow-hidden rounded-lg border border-border/40 bg-background/40">
                            <pre className="overflow-auto max-h-96 p-3 text-[11px] leading-relaxed font-mono text-muted-foreground whitespace-pre-wrap break-all code-scrollbar">
                                {logContent || <FormattedMessage id="settings.logs.empty" defaultMessage="No log content yet." />}
                                <div ref={logEndRef} />
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </SettingsSection>
    )
}
