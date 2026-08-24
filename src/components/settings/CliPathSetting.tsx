import { useState, useEffect, type ReactNode } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Check, Loader2, AlertCircle } from "lucide-react"
import { cn } from "@/lib/utils"

interface CliPathSettingProps {
  adapterId: string
  label: ReactNode
  description: ReactNode
  placeholder?: string
}

type CliPathSource = "manual" | "auto" | "missing"

export function CliPathSetting({ adapterId, label, description, placeholder }: CliPathSettingProps) {
  const intl = useIntl()
  const [path, setPath] = useState("")
  const [available, setAvailable] = useState(false)
  const [resolvedPath, setResolvedPath] = useState("")
  const [source, setSource] = useState<CliPathSource>("missing")
  const [command, setCommand] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [error, setError] = useState("")
  const [originalPath, setOriginalPath] = useState("")
  const [versionInfo, setVersionInfo] = useState<{ version?: string; error?: string; warning?: string } | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)

  useEffect(() => {
    let active = true
    api.cliPathsGet().then((configs) => {
      if (!active) return
      const config = configs[adapterId]
      setPath(config?.path ?? "")
      setOriginalPath(config?.path ?? "")
      setAvailable(config?.available ?? false)
      setResolvedPath(config?.resolvedPath ?? "")
      setSource(config?.source ?? "missing")
      setCommand(config?.command ?? "")
      setLoading(false)
    }).catch(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [adapterId])

  // Actually run the CLI once we believe we have one. Resolving a path only
  // proves a file exists and is +x — this is what catches a binary that cannot
  // start at all (wrong arch, too-old Node under an npm-installed shim), which
  // otherwise stays invisible until a chat silently fails to answer.
  useEffect(() => {
    if (!available || !resolvedPath) {
      setVersionInfo(null)
      return
    }
    let active = true
    setVersionLoading(true)
    api.cliPathVersionProbe(adapterId)
      .then((info) => { if (active) setVersionInfo(info) })
      .catch(() => { if (active) setVersionInfo(null) })
      .finally(() => { if (active) setVersionLoading(false) })
    return () => { active = false }
  }, [adapterId, available, resolvedPath])

  const isDirty = path !== originalPath

  async function handleSave() {
    setSaving(true)
    setError("")
    setSavedOk(false)
    try {
      const res = await api.cliPathSet(adapterId, path.trim() || undefined)
      setAvailable(res.info.available)
      setResolvedPath(res.info.resolvedPath ?? "")
      setSource(res.info.source)
      setCommand(res.info.command)
      setOriginalPath(path.trim())
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2000)
    } catch {
      setError(intl.formatMessage({ id: "common.saveFailed", defaultMessage: "Failed to save" }))
      setTimeout(() => setError(""), 3000)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <FormattedMessage id="common.loading" defaultMessage="Loading…" />
      </div>
    )
  }

  const inputCn = "w-full px-3 py-2 text-sm font-mono bg-background/80 rounded-xl border border-border/60 focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40"
  const hasManualOverride = path.trim().length > 0
  const isInvalidOverride = hasManualOverride && source !== "manual"
  const statusLabel = source === "manual"
    ? intl.formatMessage({ id: "settings.cli.manual", defaultMessage: "Manual override" })
    : source === "auto"
      ? intl.formatMessage({ id: "settings.cli.auto", defaultMessage: "Auto-detected" })
      : intl.formatMessage({ id: "settings.cli.notFound", defaultMessage: "Not found" })

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <span className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full",
          available
            ? "bg-green-500/10 text-green-600 dark:text-green-400"
            : "bg-muted text-muted-foreground"
        )}>
          <span className={cn(
            "h-1.5 w-1.5 rounded-full",
            available ? "bg-green-500" : "bg-muted-foreground/40"
          )} />
          {available
            ? <FormattedMessage id="settings.cli.available" defaultMessage="Available" />
            : <FormattedMessage id="settings.cli.notFound" defaultMessage="Not found" />}
        </span>
      </div>

      <div className="rounded-xl border border-border/50 bg-background/70 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground"><FormattedMessage id="settings.cli.resolution" defaultMessage="Resolution" /></span>
          <span className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
            source === "missing"
              ? "bg-muted text-muted-foreground"
              : "bg-primary/10 text-foreground"
          )}>
            {statusLabel}
          </span>
        </div>
        <div className="mt-2 text-sm font-mono text-foreground/90 break-all">
          {resolvedPath || intl.formatMessage({ id: "settings.cli.noBinary", defaultMessage: "No {command} binary detected" }, { command: command || "CLI" })}
        </div>
        {versionLoading && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <FormattedMessage id="settings.cli.checkingVersion" defaultMessage="Checking version…" />
          </div>
        )}
        {!versionLoading && versionInfo?.version && (
          <div className="mt-2 text-xs font-mono text-muted-foreground">v{versionInfo.version}</div>
        )}
        {!versionLoading && versionInfo?.warning && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-status-warn">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
            <span>{versionInfo.warning}</span>
          </div>
        )}
        {!versionLoading && versionInfo?.error && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-status-error">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
            <span>{versionInfo.error}</span>
          </div>
        )}
      </div>

      <input
        type="text"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder={placeholder ?? "/usr/local/bin/…"}
        className={inputCn}
        spellCheck={false}
      />

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {isInvalidOverride
            ? source === "auto"
              ? <FormattedMessage id="settings.cli.hintInvalidAuto" defaultMessage="Saved override is unavailable. The app is falling back to the auto-detected path." />
              : <FormattedMessage id="settings.cli.hintInvalidNone" defaultMessage="Saved override is unavailable, and no CLI was detected automatically." />
            : hasManualOverride
              ? <FormattedMessage id="settings.cli.hintManual" defaultMessage="Leave blank to use automatic discovery from your login shell." />
              : available
                ? <FormattedMessage id="settings.cli.hintAuto" defaultMessage="Automatic discovery is active. Set a custom path only if needed." />
                : <FormattedMessage id="settings.cli.hintInstall" defaultMessage="Install {command} or enter a custom path." values={{ command: command || intl.formatMessage({ id: "settings.cli.theCli", defaultMessage: "the CLI" }) }} />}
        </p>
        <div className="flex items-center gap-2">
          {savedOk && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <Check className="h-3.5 w-3.5" /> <FormattedMessage id="common.saved" defaultMessage="Saved" />
            </span>
          )}
          {error && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {error}
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="h-8 gap-1.5"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <FormattedMessage id="common.save" defaultMessage="Save" />
          </Button>
        </div>
      </div>
    </div>
  )
}
