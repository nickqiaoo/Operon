import { Fragment, useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Loader2, Play, RefreshCcw, Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorShortcut,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"
import { useModelManagement } from "@/components/editor/hooks/useModelManagement"
import { FormattedMessage, useIntl } from "react-intl"
import { api, type MemoryMaintenanceConfig, type MemoryMaintenanceRun } from "@/lib/api"

type Provider = { id: string; label: string; available: boolean }

const CLEAN_INPUT_CLASS =
  "bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background focus:border-tint/20 shadow-none transition-all"

const CLEAN_SELECT_CLASS =
  "bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors"

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function formatDuration(start: number, end?: number): string {
  if (!end) return "—"
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function statusColor(status: MemoryMaintenanceRun["status"]): string {
  switch (status) {
    case "success":
      return "text-emerald-600 dark:text-emerald-400"
    case "error":
      return "text-red-600 dark:text-red-400"
    case "running":
      return "text-blue-600 dark:text-blue-400"
    case "aborted":
      return "text-amber-600 dark:text-amber-400"
    default:
      return "text-muted-foreground"
  }
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border/40 px-4 py-3 hover:bg-muted/20 transition-colors">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="text-xs text-muted-foreground/70 truncate">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function MemoryMaintenanceSettings() {
  const intl = useIntl()
  const [config, setConfig] = useState<MemoryMaintenanceConfig | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [runs, setRuns] = useState<MemoryMaintenanceRun[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null)
  const [logs, setLogs] = useState<Record<number, { loading: boolean; content: string; error?: string }>>({})

  const toggleRunLog = async (id: number) => {
    if (expandedRunId === id) {
      setExpandedRunId(null)
      return
    }
    setExpandedRunId(id)
    if (logs[id]?.content !== undefined) return
    setLogs((prev) => ({ ...prev, [id]: { loading: true, content: "" } }))
    try {
      const res = await api.memoryMaintenanceGetRunLog(id)
      setLogs((prev) => ({
        ...prev,
        [id]: { loading: false, content: res.content ?? "", error: res.error },
      }))
    } catch (err) {
      setLogs((prev) => ({
        ...prev,
        [id]: {
          loading: false,
          content: "",
          error: err instanceof Error ? err.message : intl.formatMessage({ id: "settings.maintenance.failedLoad", defaultMessage: "Failed to load" }),
        },
      }))
    }
  }

  const reloadLog = async (id: number) => {
    setLogs((prev) => ({ ...prev, [id]: { loading: true, content: prev[id]?.content ?? "" } }))
    try {
      const res = await api.memoryMaintenanceGetRunLog(id)
      setLogs((prev) => ({
        ...prev,
        [id]: { loading: false, content: res.content ?? "", error: res.error },
      }))
    } catch (err) {
      setLogs((prev) => ({
        ...prev,
        [id]: {
          loading: false,
          content: prev[id]?.content ?? "",
          error: err instanceof Error ? err.message : intl.formatMessage({ id: "settings.maintenance.failedLoad", defaultMessage: "Failed to load" }),
        },
      }))
    }
  }

  const availableProviders = useMemo(
    () => providers.filter((p) => p.available),
    [providers]
  )

  const modelManagement = useModelManagement(
    config?.modelId ?? "",
    config?.providerId || undefined
  )
  const { model, setModel, availableModels, selectedModel } = modelManagement

  const reloadRuns = async () => {
    try {
      const list = await api.memoryMaintenanceListRuns(20)
      setRuns(Array.isArray(list) ? list : [])
    } catch {
      // leave as-is
    }
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [cfg, providerList, runList] = await Promise.all([
          api.memoryMaintenanceGetConfig(),
          api.getProviders(),
          api.memoryMaintenanceListRuns(20),
        ])
        if (cancelled) return
        setConfig(cfg)
        setProviders(providerList)
        setRuns(Array.isArray(runList) ? runList : [])
      } catch (err) {
        setError(err instanceof Error ? err.message : intl.formatMessage({ id: "settings.maintenance.failedLoad", defaultMessage: "Failed to load settings" }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const updateConfig = async (updates: Partial<Omit<MemoryMaintenanceConfig, "updatedAt">>) => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.memoryMaintenanceUpdateConfig(updates)
      setConfig(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : intl.formatMessage({ id: "settings.maintenance.failedSave", defaultMessage: "Failed to save" }))
    } finally {
      setSaving(false)
    }
  }

  const runNow = async () => {
    setRunning(true)
    setError(null)
    try {
      await api.memoryMaintenanceRunNow()
      await reloadRuns()
    } catch (err) {
      setError(err instanceof Error ? err.message : intl.formatMessage({ id: "settings.maintenance.runFailed", defaultMessage: "Run failed" }))
    } finally {
      setRunning(false)
    }
  }

  if (loading || !config) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <FormattedMessage id="settings.maintenance.loading" defaultMessage="Loading…" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold mb-1">
          <FormattedMessage id="settings.maintenance.title" defaultMessage="Memory Maintenance" />
        </h2>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="settings.maintenance.desc"
            defaultMessage="Runs once per day to scan recent conversations and extract memories the agent may have missed. Duplicates are reconciled at write time. All work happens in isolated sessions that never appear in your chat history."
          />
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <Row
          title={intl.formatMessage({ id: "settings.maintenance.enabled.title", defaultMessage: "Enabled" })}
          hint={intl.formatMessage({ id: "settings.maintenance.enabled.hint", defaultMessage: "Run the daily maintenance job." })}
        >
          <Switch
            checked={config.enabled}
            onCheckedChange={(v) => void updateConfig({ enabled: v })}
            disabled={saving}
          />
        </Row>

        <Row
          title={intl.formatMessage({ id: "settings.maintenance.scheduleTime.title", defaultMessage: "Schedule time" })}
          hint={intl.formatMessage({ id: "settings.maintenance.scheduleTime.hint", defaultMessage: "Server local time (24h, HH:MM)." })}
        >
          <Input
            value={config.scheduleTime}
            onChange={(e) => setConfig({ ...config, scheduleTime: e.target.value })}
            onBlur={() => void updateConfig({ scheduleTime: config.scheduleTime })}
            disabled={saving}
            placeholder="04:00"
            className={`${CLEAN_INPUT_CLASS} w-28 text-center font-mono`}
          />
        </Row>

        <Row
          title={intl.formatMessage({ id: "settings.maintenance.provider.title", defaultMessage: "Provider" })}
          hint={intl.formatMessage({ id: "settings.maintenance.provider.hint", defaultMessage: "Which provider drives extraction." })}
        >
          <Select
            value={config.providerId ?? ""}
            onValueChange={(v) => void updateConfig({ providerId: v || (null as unknown as string) })}
            disabled={saving}
          >
            <SelectTrigger className={`${CLEAN_SELECT_CLASS} w-56`}>
              <SelectValue placeholder={intl.formatMessage({ id: "settings.maintenance.provider.placeholder", defaultMessage: "Select provider" })} />
            </SelectTrigger>
            <SelectContent className="border-border/50">
              {availableProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
              {availableProviders.length === 0 && (
                <SelectItem disabled value="_none">
                  <FormattedMessage id="settings.maintenance.provider.none" defaultMessage="No providers available" />
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </Row>

        <Row
          title={intl.formatMessage({ id: "settings.maintenance.model.title", defaultMessage: "Model" })}
          hint={intl.formatMessage({ id: "settings.maintenance.model.hint", defaultMessage: "Pick a model — blank uses provider default." })}
        >
          <ModelSelector>
            <ModelSelectorTrigger asChild>
              <Button
                variant="outline"
                disabled={saving || !config.providerId}
                className="w-56 justify-between text-muted-foreground bg-muted/30 border-transparent hover:bg-muted/50 shadow-none font-normal h-9 px-3"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <ModelSelectorLogo provider={selectedModel?.provider ?? ""} className="size-4 shrink-0" />
                  <span className="truncate">
                    {selectedModel?.label ?? (
                      config.providerId
                        ? intl.formatMessage({ id: "settings.maintenance.model.providerDefault", defaultMessage: "Provider default" })
                        : intl.formatMessage({ id: "settings.maintenance.model.selectFirst", defaultMessage: "Select provider first" })
                    )}
                  </span>
                </span>
                <span className="text-xs opacity-50 shrink-0">
                  <FormattedMessage id="settings.maintenance.model.change" defaultMessage="Change" />
                </span>
              </Button>
            </ModelSelectorTrigger>
            <ModelSelectorContent>
              <ModelSelectorInput placeholder={intl.formatMessage({ id: "settings.maintenance.model.searchPlaceholder", defaultMessage: "Search models..." })} />
              <ModelSelectorList>
                <ModelSelectorGroup heading={intl.formatMessage({ id: "settings.maintenance.model.defaults", defaultMessage: "Defaults" })}>
                  <ModelSelectorItem
                    value="provider-default"
                    onSelect={() => {
                      setModel("")
                      void updateConfig({ modelId: null as unknown as string })
                    }}
                  >
                    <ModelSelectorName>
                      <FormattedMessage id="settings.maintenance.model.providerDefault" defaultMessage="Provider default" />
                    </ModelSelectorName>
                    {!model && (
                      <ModelSelectorShortcut>
                        <FormattedMessage id="settings.maintenance.model.current" defaultMessage="current" />
                      </ModelSelectorShortcut>
                    )}
                  </ModelSelectorItem>
                </ModelSelectorGroup>
                {Object.entries(
                  availableModels.reduce<Record<string, typeof availableModels>>((groups, item) => {
                    (groups[item.group] ??= []).push(item)
                    return groups
                  }, {})
                ).map(([group, items]) => (
                  <ModelSelectorGroup key={group} heading={group}>
                    {items.map((item) => (
                      <ModelSelectorItem
                        key={item.id}
                        value={`${item.label} ${item.id}`}
                        onSelect={() => {
                          setModel(item.id)
                          void updateConfig({ modelId: item.id })
                        }}
                      >
                        <ModelSelectorLogo provider={item.provider} />
                        <ModelSelectorName>{item.label}</ModelSelectorName>
                        {model === item.id && (
                          <ModelSelectorShortcut>
                            <FormattedMessage id="settings.maintenance.model.current" defaultMessage="current" />
                          </ModelSelectorShortcut>
                        )}
                      </ModelSelectorItem>
                    ))}
                  </ModelSelectorGroup>
                ))}
              </ModelSelectorList>
            </ModelSelectorContent>
          </ModelSelector>
        </Row>

        <Row
          title={intl.formatMessage({ id: "settings.maintenance.layer1.title", defaultMessage: "Extract" })}
          hint={intl.formatMessage({ id: "settings.maintenance.layer1.hint", defaultMessage: "Scan recent chats and write missed memories. Duplicates are reconciled at write time." })}
        >
          <Switch
            checked={config.layer1Enabled}
            onCheckedChange={(v) => void updateConfig({ layer1Enabled: v })}
            disabled={saving}
          />
        </Row>

        <Row
          title={intl.formatMessage({ id: "settings.maintenance.maxSessions.title", defaultMessage: "Max chats per run" })}
          hint={intl.formatMessage({ id: "settings.maintenance.maxSessions.hint", defaultMessage: "Cap for the extract pass to bound cost." })}
        >
          <Input
            type="number"
            min={1}
            max={500}
            value={config.maxSessionsPerRun}
            onChange={(e) => setConfig({ ...config, maxSessionsPerRun: Number(e.target.value) })}
            onBlur={() => void updateConfig({ maxSessionsPerRun: config.maxSessionsPerRun })}
            disabled={saving}
            className={`${CLEAN_INPUT_CLASS} w-24 text-center`}
          />
        </Row>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void runNow()}
          disabled={running || !config.enabled || !config.providerId}
          className="h-8 gap-1.5"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          <FormattedMessage id="settings.maintenance.runNow" defaultMessage="Run now" />
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void reloadRuns()} className="gap-1.5">
          <RefreshCcw className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.maintenance.refresh" defaultMessage="Refresh" />
        </Button>
      </div>

      <div className="pt-4">
        <div className="flex items-center gap-2 mb-3">
          <Wand2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            <FormattedMessage id="settings.maintenance.recentRuns" defaultMessage="Recent runs" />
          </h3>
        </div>
        {runs.length === 0 ? (
          <div className="text-xs text-muted-foreground px-4 py-6 rounded-xl border border-border/40 text-center">
            <FormattedMessage id="settings.maintenance.noRuns" defaultMessage='No runs yet. Click "Run now" to trigger one manually.' />
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/20">
                <tr className="text-left text-muted-foreground">
                  <th className="w-6" />
                  <th className="px-3 py-2 font-medium">
                    <FormattedMessage id="settings.maintenance.col.started" defaultMessage="Started" />
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <FormattedMessage id="settings.maintenance.col.status" defaultMessage="Status" />
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <FormattedMessage id="settings.maintenance.col.trigger" defaultMessage="Trigger" />
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    <FormattedMessage id="settings.maintenance.col.sessions" defaultMessage="Sessions" />
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    <FormattedMessage id="settings.maintenance.col.written" defaultMessage="Written" />
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    <FormattedMessage id="settings.maintenance.col.tokens" defaultMessage="Tokens" />
                  </th>
                  <th className="px-3 py-2 font-medium text-right">
                    <FormattedMessage id="settings.maintenance.col.duration" defaultMessage="Duration" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const expanded = expandedRunId === r.id
                  const log = logs[r.id]
                  return (
                    <Fragment key={r.id}>
                      <tr
                        onClick={() => void toggleRunLog(r.id)}
                        className="border-t border-border/40 hover:bg-muted/10 transition-colors cursor-pointer"
                      >
                        <td className="pl-3 pr-0 py-2 text-muted-foreground">
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{formatDateTime(r.startedAt)}</td>
                        <td className={`px-3 py-2 font-medium ${statusColor(r.status)}`}>{r.status}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.trigger}</td>
                        <td className="px-3 py-2 text-right">{r.sessionsProcessed}</td>
                        <td className="px-3 py-2 text-right">{r.memoriesWritten}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {r.tokensInput + r.tokensOutput}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {formatDuration(r.startedAt, r.finishedAt)}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-t border-border/40 bg-muted/10">
                          <td />
                          <td colSpan={7} className="px-3 py-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="text-[11px] text-muted-foreground">
                                <FormattedMessage id="settings.maintenance.runLog" defaultMessage="Run #{id} log" values={{ id: r.id }} />
                                {r.error && (
                                  <span className="ml-2 text-red-500">
                                    <FormattedMessage id="settings.maintenance.runError" defaultMessage="error: {error}" values={{ error: r.error }} />
                                  </span>
                                )}
                              </div>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void reloadLog(r.id)
                                }}
                                className="h-6 gap-1 text-[11px]"
                              >
                                <RefreshCcw className="h-3 w-3" />
                                <FormattedMessage id="settings.maintenance.reload" defaultMessage="Reload" />
                              </Button>
                            </div>
                            {log?.loading && !log.content ? (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground px-2 py-3">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                <FormattedMessage id="settings.maintenance.loadingLog" defaultMessage="Loading log…" />
                              </div>
                            ) : log?.error && !log.content ? (
                              <div className="text-xs text-muted-foreground px-2 py-3">
                                {log.error === "log not found"
                                  ? <FormattedMessage id="settings.maintenance.logNotFound" defaultMessage="No log file for this run. (Runs from before logging was enabled have no file.)" />
                                  : log.error}
                              </div>
                            ) : (
                              <pre className="max-h-80 overflow-auto rounded-lg bg-muted/40 p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all">
                                {log?.content || <FormattedMessage id="settings.maintenance.logEmpty" defaultMessage="(empty)" />}
                              </pre>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
