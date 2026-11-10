import { useMemo, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { GitCommitHorizontal, Loader2, Check } from "lucide-react"
import { api } from "@/lib/api"
import { useProviderModels, useProviders } from "@/lib/provider-queries"
import { setSettingsData, settingsKeys, useCommitMessageConfig } from "@/lib/settings-queries"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useTransientFlag } from "@/hooks/useTransientFlag"
import { ModelCombobox } from "./ModelCombobox"

interface ModelOption {
  modelId: string
  name: string
}

/**
 * Settings section that picks which runtime provider + model writes commit
 * messages when the Commit dialog's message is left blank. The generator runs
 * the chosen provider headlessly with the diff inlined in the prompt.
 */
export function CommitMessageSettings() {
  const intl = useIntl()
  const [saving, setSaving] = useState(false)
  const [savedOk, flashSavedOk, clearSavedOk] = useTransientFlag(2000)

  const providersQuery = useProviders()
  const configQuery = useCommitMessageConfig()
  const providers = providersQuery.data ?? []
  const loading = providersQuery.isPending || configQuery.isPending

  // The user's picks; null until they choose, so the saved config (or the first
  // available provider / first model) shows through without being copied in.
  const [pickedProvider, setPickedProvider] = useState<string | null>(null)
  const [pickedModel, setPickedModel] = useState<string | null>(null)

  const providerId =
    pickedProvider ??
    (configQuery.data?.providerId || providers.find((p) => p.available)?.id || "")

  const modelsQuery = useProviderModels(providerId || undefined)
  const models = useMemo<ModelOption[]>(
    () => (modelsQuery.data?.models ?? []).flatMap((m) => (m.modelId ? [{ modelId: m.modelId, name: m.name }] : [])),
    [modelsQuery.data],
  )
  const modelsLoading = !!providerId && modelsQuery.isPending

  // Keep the chosen (or saved) model if this provider still offers it, else the first.
  const preferredModel = pickedModel ?? (pickedProvider == null ? configQuery.data?.modelId : undefined)
  const modelId =
    preferredModel && models.some((m) => m.modelId === preferredModel) ? preferredModel : models[0]?.modelId ?? ""
  const setModelId = (next: string) => setPickedModel(next)

  const handleProviderChange = (pid: string) => {
    setPickedProvider(pid)
    setPickedModel(null)
  }

  const handleSave = async () => {
    setSaving(true)
    clearSavedOk()
    try {
      const saved = await api.commitMessageSaveConfig({ providerId, modelId })
      setSettingsData(settingsKeys.commitMessage(), { providerId: saved.providerId, modelId: saved.modelId })
      flashSavedOk()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <GitCommitHorizontal className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold mb-1"><FormattedMessage id="settings.commitMsg.title" defaultMessage="Commit message generation" /></h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            <FormattedMessage id="settings.commitMsg.desc" defaultMessage="When you leave the message empty in the Commit dialog, Operon asks this agent to write one from the staged diff. The provider runs headlessly with the diff inlined — no tools are invoked." />
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> <FormattedMessage id="common.loading" defaultMessage="Loading…" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 items-center text-xs text-muted-foreground rounded-lg bg-background/40 border border-border/40 p-3">
            <span className="font-medium"><FormattedMessage id="settings.provider" defaultMessage="Provider" /></span>
            <Select value={providerId} onValueChange={handleProviderChange}>
              <SelectTrigger className="h-8 text-xs w-full max-w-[280px] bg-background/80 border-border/50">
                <SelectValue placeholder={intl.formatMessage({ id: "settings.selectProvider", defaultMessage: "Select a provider" })} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem
                    key={p.id}
                    value={p.id}
                    disabled={!p.available}
                    className="text-xs"
                  >
                    {p.label}
                    {!p.available ? intl.formatMessage({ id: "settings.unavailable", defaultMessage: " (unavailable)" }) : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="font-medium"><FormattedMessage id="settings.model" defaultMessage="Model" /></span>
            <div className="flex items-center gap-2 min-w-0">
              <ModelCombobox
                value={modelId}
                onValueChange={setModelId}
                models={models}
                placeholder={modelsLoading
                  ? intl.formatMessage({ id: "common.loading", defaultMessage: "Loading…" })
                  : intl.formatMessage({ id: "settings.selectModel", defaultMessage: "Select a model" })}
                disabled={modelsLoading || models.length === 0}
                className="w-full max-w-[280px]"
              />
              {modelsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              onClick={handleSave}
              disabled={saving || !providerId || !modelId}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : savedOk ? (
                <Check className="h-3.5 w-3.5" />
              ) : null}
              {savedOk
                ? <FormattedMessage id="common.saved" defaultMessage="Saved" />
                : <FormattedMessage id="common.save" defaultMessage="Save" />}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
