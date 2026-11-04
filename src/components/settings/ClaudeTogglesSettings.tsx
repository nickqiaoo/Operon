import { useMutation } from "@tanstack/react-query"
import { FormattedMessage } from "react-intl"
import { Loader2, ToggleRight } from "lucide-react"

import type { ClaudeToggles } from "@shared/claude-toggles"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { queryClient } from "@/lib/query-client"
import { settingsKeys, useClaudeToggles } from "@/lib/settings-queries"
import { SettingsRow, SettingsSection } from "./SettingsSection"

/**
 * Operon's Claude Code switches. Each is passed to every Claude session as the
 * environment variable that decides it, which outranks Claude Code's settings
 * files — so the switch is what runs, whatever those files say.
 */
export function ClaudeTogglesSettings() {
  const { data, isLoading, error } = useClaudeToggles()

  const save = useMutation({
    mutationFn: (patch: Partial<ClaudeToggles>) => api.claudeTogglesSave(patch),
    onMutate: (patch) => {
      const previous = queryClient.getQueryData<ClaudeToggles>(settingsKeys.claudeToggles())
      if (previous) queryClient.setQueryData(settingsKeys.claudeToggles(), { ...previous, ...patch })
      return { previous }
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(settingsKeys.claudeToggles(), context.previous)
    },
    onSuccess: (saved) => queryClient.setQueryData(settingsKeys.claudeToggles(), saved),
  })

  const toggle = (key: keyof ClaudeToggles) => (checked: boolean) => save.mutate({ [key]: checked })

  return (
    <SettingsSection
      icon={ToggleRight}
      title={<FormattedMessage id="settings.claudeToggles.title" defaultMessage="Features" />}
      description={
        <FormattedMessage
          id="settings.claudeToggles.desc"
          defaultMessage="Applied to every Claude session as environment variables, so they override Claude Code's own settings files. Takes effect from the next message."
        />
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error || !data ? (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <FormattedMessage id="settings.claudeToggles.loadError" defaultMessage="Couldn't load these settings." />
        </div>
      ) : (
        <div>
          <SettingsRow
            title={<FormattedMessage id="settings.claudeToggles.promptSuggestions.title" defaultMessage="Prompt suggestions" />}
            description={
              <FormattedMessage
                id="settings.claudeToggles.promptSuggestions.desc"
                defaultMessage="After each reply, suggest what you might ask next; press Tab to use it. Not offered on a conversation's first turn, in Plan mode, or once the usage limit is reached."
              />
            }
            control={
              <Switch
                data-testid="claude-toggle-prompt-suggestions"
                checked={data.promptSuggestions}
                onCheckedChange={toggle("promptSuggestions")}
              />
            }
          />
          <SettingsRow
            title={<FormattedMessage id="settings.claudeToggles.autoMemory.title" defaultMessage="Auto memory" />}
            description={
              <FormattedMessage
                id="settings.claudeToggles.autoMemory.desc"
                defaultMessage="Let Claude Code save and recall notes about your projects across conversations."
              />
            }
            control={
              <Switch
                data-testid="claude-toggle-auto-memory"
                checked={data.autoMemory}
                onCheckedChange={toggle("autoMemory")}
              />
            }
          />
          {save.isError && (
            <div className="flex items-center gap-2 pt-3 text-xs text-destructive">
              <FormattedMessage id="settings.claudeToggles.saveError" defaultMessage="Couldn't save. Try again." />
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  )
}
