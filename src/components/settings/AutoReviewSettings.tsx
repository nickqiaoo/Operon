import { useMutation } from "@tanstack/react-query"
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"
import { useProviderModelOptions } from "@/lib/provider-queries"
import { setSettingsData, settingsKeys, useAutoReviewConfig } from "@/lib/settings-queries"
import { ModelCombobox } from "./ModelCombobox"
import { SettingsSection } from "./SettingsSection"

/** Picks the model that judges tool calls in Operon's Auto mode, for chats and the assistant alike. */
export function AutoReviewSettings() {
  const intl = useIntl()
  const config = useAutoReviewConfig()
  const models = useProviderModelOptions("custom")
  const save = useMutation({
    mutationFn: (modelId: string) => api.autoReviewSaveConfig({ modelId }),
    onSuccess: (saved) => setSettingsData(settingsKeys.autoReview(), saved),
  })

  const modelId = (save.isPending ? save.variables : config.data?.modelId) ?? ""
  // A saved model that is no longer offered still shows, so the user sees why.
  const options =
    models && modelId && !models.some((m) => m.modelId === modelId)
      ? [
          {
            modelId,
            name: intl.formatMessage({ id: "assistant.settings.modelUnavailable", defaultMessage: "{model} (unavailable)" }, { model: modelId }),
          },
          ...models,
        ]
      : (models ?? [])

  return (
    <SettingsSection
      icon={ShieldCheck}
      title={<FormattedMessage id="settings.autoReview.title" defaultMessage="Auto review model" />}
      description={
        <FormattedMessage
          id="settings.autoReview.desc"
          defaultMessage="Reviews tool calls when Operon runs in Auto mode, in chats and in the assistant. Pick a steady model that isn't rate limited."
        />
      }
    >
      {config.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> <FormattedMessage id="common.loading" defaultMessage="Loading…" />
        </div>
      ) : (
        <ModelCombobox
          value={modelId}
          onValueChange={(next) => save.mutate(next)}
          models={options}
          defaultLabel={intl.formatMessage({ id: "settings.autoReview.sameAsSession", defaultMessage: "Same as the session" })}
          loading={models === null}
          disabled={save.isPending}
          aria-label={intl.formatMessage({ id: "settings.autoReview.title", defaultMessage: "Auto review model" })}
          className="w-full max-w-[320px]"
        />
      )}
      {(save.error || config.error) && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.autoReview.saveFailed" defaultMessage="Couldn't load or save the model. Try again." />
        </div>
      )}
    </SettingsSection>
  )
}
