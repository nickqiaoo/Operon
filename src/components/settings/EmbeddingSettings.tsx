import { useState, useEffect, useCallback } from "react"
import { Loader2, Download, Check, Cpu, Database, HardDrive } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SettingsSection } from "./SettingsSection"
import { cn } from "@/lib/utils"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"

interface EmbeddingConfig {
    enabled: boolean
    dimensions?: number
}

interface ModelStatus {
    name: string
    uri: string
    downloaded: boolean
    sizeBytes: number
}

interface LLMStatus {
    gpuType: string | false
    gpuDevices: string[]
    vram?: { total: number; used: number; free: number }
    cpuCores: number
    models: {
        embed: ModelStatus
        rerank: ModelStatus
    }
    downloading: boolean
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B"
    const mb = bytes / (1024 * 1024)
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
}

export function EmbeddingSettings() {
    const intl = useIntl()
    const [config, setConfig] = useState<EmbeddingConfig | null>(null)
    const [status, setStatus] = useState<LLMStatus | null>(null)
    const [configLoading, setConfigLoading] = useState(true)
    const [statusLoading, setStatusLoading] = useState(true)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ success: boolean; dimensions: number } | null>(null)
    const [downloading, setDownloading] = useState(false)

    const loadStatus = useCallback(async () => {
        try {
            const s = await api.embeddingGetStatus()
            setStatus(s)
            if (s.downloading) {
                setDownloading(true)
            } else {
                setDownloading(false)
            }
        } catch { /* ignore */ }
    }, [])

    useEffect(() => {
        api.embeddingGetConfig()
            .then(setConfig)
            .catch(() => {})
            .finally(() => setConfigLoading(false))
        loadStatus().finally(() => setStatusLoading(false))
    }, [loadStatus])

    useEffect(() => {
        if (!downloading) return
        const interval = setInterval(loadStatus, 3000)
        return () => clearInterval(interval)
    }, [downloading, loadStatus])

    const handleToggle = async () => {
        if (!config) return
        const updated = { ...config, enabled: !config.enabled }
        setConfig(updated)
        try {
            const res = await api.embeddingUpdateConfig(updated as unknown as Record<string, unknown>)
            setConfig(res)
            if (res.enabled) {
                setDownloading(true)
                setTimeout(loadStatus, 2000)
            }
        } catch {
            setConfig(config)
        }
    }

    const handleDownload = async () => {
        setDownloading(true)
        try {
            await api.embeddingDownload()
            setTimeout(loadStatus, 2000)
        } catch {
            setDownloading(false)
        }
    }

    const handleTest = async () => {
        setTesting(true)
        setTestResult(null)
        try {
            const res = await api.embeddingTest("Hello world test")
            setTestResult(res)
            await loadStatus()
        } catch {
            setTestResult({ success: false, dimensions: 0 })
        } finally {
            setTesting(false)
        }
    }

    if (configLoading || !config) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        )
    }

    const modelsReady = status?.models.embed.downloaded && status?.models.rerank.downloaded

    const enableLabel = intl.formatMessage({ id: "settings.embedding.title", defaultMessage: "Enable Memory Embedding" })

    return (
        <SettingsSection
            icon={Database}
            title={enableLabel}
            description={<FormattedMessage id="settings.embedding.desc" defaultMessage="Local vector search for memory extraction and retrieval" />}
            action={<Switch aria-label={enableLabel} checked={config.enabled} onCheckedChange={() => void handleToggle()} />}
        >
            {statusLoading ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <FormattedMessage id="settings.embedding.loadingDevice" defaultMessage="Loading device status..." />
                </div>
            ) : status ? (
                <>
                    <div className="space-y-4">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <FormattedMessage id="settings.embedding.device" defaultMessage="Device" />
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                            <div className="flex items-center gap-1.5">
                                <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                                <span>
                                    {status.gpuType
                                        ? intl.formatMessage(
                                            { id: "settings.embedding.gpu", defaultMessage: "{type} ({device})" },
                                            { type: String(status.gpuType).toUpperCase(), device: status.gpuDevices[0] || "GPU" }
                                          )
                                        : intl.formatMessage(
                                            { id: "settings.embedding.cpu", defaultMessage: "CPU ({cores} cores)" },
                                            { cores: status.cpuCores }
                                          )
                                    }
                                </span>
                            </div>
                            {status.vram && (
                                <div className="flex items-center gap-1.5 text-muted-foreground">
                                    <HardDrive className="h-3.5 w-3.5" />
                                    <span>
                                        <FormattedMessage
                                            id="settings.embedding.vram"
                                            defaultMessage="VRAM: {free} free / {total}"
                                            values={{ free: formatBytes(status.vram.free), total: formatBytes(status.vram.total) }}
                                        />
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="space-y-4">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <FormattedMessage id="settings.embedding.models" defaultMessage="Models" />
                        </div>

                        <div className="space-y-3">
                            <ModelRow
                                model={status.models.embed}
                                label={intl.formatMessage({ id: "settings.embedding.modelEmbed", defaultMessage: "Embedding" })}
                                notDownloadedLabel={intl.formatMessage({ id: "settings.embedding.notDownloaded", defaultMessage: "Not downloaded" })}
                            />
                            <ModelRow
                                model={status.models.rerank}
                                label={intl.formatMessage({ id: "settings.embedding.modelRerank", defaultMessage: "Reranker" })}
                                notDownloadedLabel={intl.formatMessage({ id: "settings.embedding.notDownloaded", defaultMessage: "Not downloaded" })}
                            />
                        </div>

                        {!modelsReady && (
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={handleDownload}
                                disabled={downloading}
                                className="gap-1.5"
                            >
                                {downloading
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Download className="h-3.5 w-3.5" />
                                }
                                {downloading
                                    ? <FormattedMessage id="settings.embedding.downloading" defaultMessage="Downloading..." />
                                    : <FormattedMessage id="settings.embedding.downloadModels" defaultMessage="Download Models" />
                                }
                            </Button>
                        )}

                        {modelsReady && !downloading && (
                            <div className="flex items-center gap-1 text-xs text-status-ok">
                                <Check className="h-3.5 w-3.5" />
                                <FormattedMessage id="settings.embedding.allReady" defaultMessage="All models ready" />
                            </div>
                        )}
                    </div>
                </>
            ) : null}

            <div className="flex items-center gap-2 border-t border-border/40 pt-4 dark:border-border/35">
                <Button size="sm" variant="secondary" onClick={handleTest} disabled={testing || !config.enabled} className="h-8 gap-1.5">
                    {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    <FormattedMessage id="settings.embedding.testButton" defaultMessage="Test Embedding" />
                </Button>
                {testResult && (
                    <span className={cn("text-xs", testResult.success ? "text-status-ok" : "text-status-error")}>
                        {testResult.success
                            ? <FormattedMessage id="settings.embedding.testOk" defaultMessage="OK ({dims}d)" values={{ dims: testResult.dimensions }} />
                            : <FormattedMessage id="settings.embedding.testFailed" defaultMessage="Failed" />
                        }
                    </span>
                )}
            </div>
        </SettingsSection>
    )
}

function ModelRow({ model, label, notDownloadedLabel }: { model: ModelStatus; label: string; notDownloadedLabel: string }) {
    return (
        <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/40 px-3 py-2">
            <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{model.name}</div>
            </div>
            <div className="text-right">
                {model.downloaded ? (
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">{formatBytes(model.sizeBytes)}</span>
                        <Check className="h-3.5 w-3.5 text-status-ok" />
                    </div>
                ) : (
                    <span className="text-xs text-muted-foreground">{notDownloadedLabel}</span>
                )}
            </div>
        </div>
    )
}
