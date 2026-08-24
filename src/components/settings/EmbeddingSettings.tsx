import { useState, useEffect, useCallback } from "react"
import { Loader2, Download, Check, Cpu, HardDrive } from "lucide-react"
import { Button } from "@/components/ui/button"
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
        <div className="space-y-6">
            <div className="flex items-center justify-between pb-6 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1">{enableLabel}</div>
                    <div className="text-sm text-muted-foreground">
                        <FormattedMessage id="settings.embedding.desc" defaultMessage="Local vector search for memory extraction and retrieval" />
                    </div>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-label={enableLabel}
                    aria-checked={config.enabled}
                    onClick={handleToggle}
                    className={cn(
                        "relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none cursor-pointer",
                        config.enabled ? "bg-green-500" : "bg-muted-foreground/30"
                    )}
                >
                    <span className={cn(
                        "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200",
                        config.enabled ? "translate-x-4" : "translate-x-0"
                    )} />
                </button>
            </div>

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
                            <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                                <Check className="h-3.5 w-3.5" />
                                <FormattedMessage id="settings.embedding.allReady" defaultMessage="All models ready" />
                            </div>
                        )}
                    </div>
                </>
            ) : null}

            <div className="flex items-center gap-2 pt-2 border-t border-border/60">
                <Button size="sm" variant="secondary" onClick={handleTest} disabled={testing || !config.enabled} className="gap-1.5">
                    {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    <FormattedMessage id="settings.embedding.testButton" defaultMessage="Test Embedding" />
                </Button>
                {testResult && (
                    <span className={cn("text-xs", testResult.success ? "text-green-600 dark:text-green-400" : "text-destructive")}>
                        {testResult.success
                            ? <FormattedMessage id="settings.embedding.testOk" defaultMessage="OK ({dims}d)" values={{ dims: testResult.dimensions }} />
                            : <FormattedMessage id="settings.embedding.testFailed" defaultMessage="Failed" />
                        }
                    </span>
                )}
            </div>
        </div>
    )
}

function ModelRow({ model, label, notDownloadedLabel }: { model: ModelStatus; label: string; notDownloadedLabel: string }) {
    return (
        <div className="flex items-center justify-between py-2 px-3 bg-muted/20 rounded-lg">
            <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{model.name}</div>
            </div>
            <div className="text-right">
                {model.downloaded ? (
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">{formatBytes(model.sizeBytes)}</span>
                        <Check className="h-3.5 w-3.5 text-green-500" />
                    </div>
                ) : (
                    <span className="text-xs text-muted-foreground">{notDownloadedLabel}</span>
                )}
            </div>
        </div>
    )
}
