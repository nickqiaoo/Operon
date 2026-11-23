import { useMutation } from "@tanstack/react-query"
import { FormattedMessage, useIntl } from "react-intl"
import { AlertCircle, Check, Loader2, RefreshCw } from "lucide-react"

import type { CliAutoUpdateAdapterId, CliAutoUpdateState, CliAutoUpdateStatus } from "@shared/cli-auto-update"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { formatRelativeTime } from "@/lib/format"
import { queryClient } from "@/lib/query-client"
import { settingsKeys, useCliAutoUpdate } from "@/lib/settings-queries"
import { SettingsRow, SettingsSection } from "./SettingsSection"

const COMMANDS: Record<CliAutoUpdateAdapterId, string> = {
  "claude-code": "claude update",
  codex: "codex update",
}

function writeStatus(adapterId: CliAutoUpdateAdapterId, status: CliAutoUpdateStatus) {
  queryClient.setQueryData<CliAutoUpdateState>(settingsKeys.cliAutoUpdate(), (prev) =>
    prev ? { ...prev, [adapterId]: status } : prev,
  )
}

/**
 * Keeps the CLI an SDK adapter drives current by running its own `update`
 * command once a day (server/src/services/cli-auto-update.ts).
 */
export function CliAutoUpdateSettings({ adapterId, name }: { adapterId: CliAutoUpdateAdapterId; name: string }) {
  const intl = useIntl()
  const { data, isLoading, error } = useCliAutoUpdate()
  const status = data?.[adapterId]
  const command = COMMANDS[adapterId]

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.cliAutoUpdateSetEnabled(adapterId, enabled),
    onMutate: (enabled) => {
      const previous = queryClient.getQueryData<CliAutoUpdateState>(settingsKeys.cliAutoUpdate())
      if (previous) writeStatus(adapterId, { ...previous[adapterId], enabled })
      return { previous }
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) queryClient.setQueryData(settingsKeys.cliAutoUpdate(), context.previous)
    },
    onSuccess: (saved) => writeStatus(adapterId, saved),
  })

  const runNow = useMutation({
    mutationFn: () => api.cliAutoUpdateRun(adapterId),
    onSuccess: (saved) => writeStatus(adapterId, saved),
  })

  const running = status?.running === true || runNow.isPending

  return (
    <SettingsSection
      icon={RefreshCw}
      title={<FormattedMessage id="settings.cliAutoUpdate.title" defaultMessage="Auto-update" />}
      description={
        <FormattedMessage
          id="settings.cliAutoUpdate.desc"
          defaultMessage="The {name} SDK runs the CLI installed on this machine. Keep it current by running `{command}` once a day."
          values={{ name, command }}
        />
      }
      action={
        status && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs"
            disabled={running}
            onClick={() => runNow.mutate()}
            data-testid={`cli-auto-update-run-${adapterId}`}
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <FormattedMessage id="settings.cliAutoUpdate.runNow" defaultMessage="Update now" />
          </Button>
        )
      }
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error || !status ? (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <FormattedMessage id="settings.cliAutoUpdate.loadError" defaultMessage="Couldn't load auto-update settings." />
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <SettingsRow
              title={<FormattedMessage id="settings.cliAutoUpdate.toggle.title" defaultMessage="Update automatically" />}
              description={
                <FormattedMessage
                  id="settings.cliAutoUpdate.toggle.desc"
                  defaultMessage="Checks once a day while Operon is running. Open chats keep their current CLI; new ones use the updated version."
                />
              }
              control={
                <Switch
                  data-testid={`cli-auto-update-toggle-${adapterId}`}
                  checked={status.enabled}
                  onCheckedChange={(checked) => toggle.mutate(checked)}
                />
              }
            />
          </div>
          <LastRunLine status={status} running={running} intl={intl} />
          {(toggle.isError || runNow.isError) && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <FormattedMessage id="settings.cliAutoUpdate.saveError" defaultMessage="Couldn't reach the server. Try again." />
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  )
}

function LastRunLine({
  status,
  running,
  intl,
}: {
  status: CliAutoUpdateStatus
  running: boolean
  intl: ReturnType<typeof useIntl>
}) {
  if (running) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <FormattedMessage id="settings.cliAutoUpdate.running" defaultMessage="Updating…" />
      </div>
    )
  }

  const last = status.lastRun
  if (!last) {
    return (
      <div className="text-xs text-muted-foreground">
        <FormattedMessage id="settings.cliAutoUpdate.never" defaultMessage="Not checked yet." />
      </div>
    )
  }

  const when = formatRelativeTime(intl, last.finishedAt)

  if (last.outcome === "failed") {
    return (
      <div className="flex items-start gap-2 text-xs text-destructive">
        <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {last.error}
          <span className="text-muted-foreground"> · {when}</span>
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Check className="h-3.5 w-3.5 shrink-0 text-status-ok" />
      {last.outcome === "updated" ? (
        <FormattedMessage
          id="settings.cliAutoUpdate.updated"
          defaultMessage="Updated {from} → {to} · {when}"
          values={{ from: last.fromVersion, to: last.toVersion, when }}
        />
      ) : last.toVersion ? (
        <FormattedMessage
          id="settings.cliAutoUpdate.upToDate"
          defaultMessage="Up to date ({version}) · checked {when}"
          values={{ version: last.toVersion, when }}
        />
      ) : (
        <FormattedMessage
          id="settings.cliAutoUpdate.upToDateNoVersion"
          defaultMessage="Up to date · checked {when}"
          values={{ when }}
        />
      )}
    </div>
  )
}
