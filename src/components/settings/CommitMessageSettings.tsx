import { useCallback, useEffect, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { GitCommitHorizontal, Loader2, Check } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface ProviderOption {
  id: string
  label: string
  available: boolean
}

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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)

  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  const [providerId, setProviderId] = useState("")
  const [modelId, setModelId] = useState("")

  const loadModels = useCallback(async (pid: string, preferredModelId?: string) => {
    if (!pid) {
      setModels([])
      return
    }
    setModelsLoading(true)
    try {
      const result = (await api.getProviderModels(pid)) as {
        models?: Array<{ modelId: string; name: string }>
      }
      const list: ModelOption[] = (result?.models ?? []).map((m) => ({
        modelId: m.modelId,
        name: m.name,
      }))
      setModels(list)
      // Keep the saved model if still valid, else default to the first.
      setModelId((prev) => {
        const target = preferredModelId ?? prev
        if (target && list.some((m) => m.modelId === target)) return target
        return list[0]?.modelId ?? ""
      })
    } catch {
      setModels([])
    } finally {
      setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const [providerList, config] = await Promise.all([
          api.getProviders(),
          api.commitMessageGetConfig(),
        ])
        setProviders(providerList)
        const initialProvider = config.providerId || providerList.find((p) => p.available)?.id || ""
        setProviderId(initialProvider)
        if (initialProvider) await loadModels(initialProvider, config.modelId)
      } finally {
        setLoading(false)
      }
    })()
  }, [loadModels])

  const handleProviderChange = (pid: string) => {
    setProviderId(pid)
    setModelId("")
    void loadModels(pid)
  }

  const handleSave = async () => {
    setSaving(true)
    setSavedOk(false)
    try {
      await api.commitMessageSaveConfig({ providerId, modelId })
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2000)
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
              <Select
                value={modelId}
                onValueChange={setModelId}
                disabled={modelsLoading || models.length === 0}
              >
                <SelectTrigger className="h-8 text-xs w-full max-w-[280px] bg-background/80 border-border/50">
                  <SelectValue placeholder={modelsLoading
                    ? intl.formatMessage({ id: "common.loading", defaultMessage: "Loading…" })
                    : intl.formatMessage({ id: "settings.selectModel", defaultMessage: "Select a model" })} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.modelId} value={m.modelId} className="text-xs">
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
