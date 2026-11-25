import { useState, type ReactNode } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"
import { setSettingsData, settingsKeys, useCliPaths, useCliVersion } from "@/lib/settings-queries"
import { Button } from "@/components/ui/button"
import { Check, Loader2, AlertCircle } from "lucide-react"
import { useTransientFlag } from "@/hooks/useTransientFlag"

interface CliPathSettingProps {
  adapterId: string
  label: ReactNode
  description: ReactNode
  placeholder?: string
}

type CliPathSource = "manual" | "auto" | "missing"

export function CliPathSetting({ adapterId, label, description, placeholder }: CliPathSettingProps) {
  const intl = useIntl()
  const { data: configs, isLoading: loading } = useCliPaths()
  const config = configs?.[adapterId]
  const originalPath = config?.path ?? ""
  // The draft is seeded from the saved value and reseeded whenever that changes
  // (a save, or the agent list re-detecting) — never written back until Save.
  const [path, setPath] = useState(originalPath)
  const [seededFrom, setSeededFrom] = useState(originalPath)
  if (seededFrom !== originalPath) {
    setSeededFrom(originalPath)
    setPath(originalPath)
  }
  const available = config?.available ?? false
  const source: CliPathSource = config?.source ?? "missing"
  const command = config?.command ?? ""
  const [saving, setSaving] = useState(false)
  const [savedOk, flashSavedOk, clearSavedOk] = useTransientFlag(2000)
  const [error, setError] = useState("")
  // Actually run the CLI once we believe we have one. Resolving a path only
  // proves a file exists and is +x — this is what catches a binary that cannot
  // start at all (wrong arch, too-old Node under an npm-installed shim), which
  // otherwise stays invisible until a chat silently fails to answer.
  const { data: versionInfo, isFetching: versionLoading } = useCliVersion(adapterId, config)

  const isDirty = path !== originalPath

  async function handleSave() {
    setSaving(true)
    setError("")
    clearSavedOk()
    try {
      const res = await api.cliPathSet(adapterId, path.trim() || undefined)
      setSettingsData(settingsKeys.cliPaths(), { ...configs, [adapterId]: res.info })
      flashSavedOk()
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

  const inputCn = "w-full px-3 py-2 text-sm font-mono bg-background/80 rounded-xl border border-border/60 focus:outline-none focus:border-tint/40 focus:ring-1 focus:ring-tint/10 placeholder:text-muted-foreground/40"
  const hasManualOverride = path.trim().length > 0
  const isInvalidOverride = originalPath.trim().length > 0 && source !== "manual"
  return (
    <div className="space-y-2">
      {versionLoading && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <FormattedMessage id="settings.cli.checkingVersion" defaultMessage="Checking version…" />
        </div>
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
      <details open={!available || isInvalidOverride}>
        <summary className="w-fit cursor-pointer rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground">{label}</summary>
        <div className="mt-3 space-y-3">
          <label htmlFor={`cli-path-${adapterId}`} className="block text-xs text-muted-foreground">{description}</label>
          <input
            id={`cli-path-${adapterId}`}
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
                <span className="flex items-center gap-1 text-xs text-status-ok">
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
      </details>
    </div>
  )
}
