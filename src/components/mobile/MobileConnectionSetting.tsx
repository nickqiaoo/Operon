import { useMutation, useQueryClient } from "@tanstack/react-query"
import { defineMessages, FormattedMessage, useIntl } from "react-intl"
import type { DirectRouteMode } from "@shared/delegations"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { isAccountless, setRouteMode } from "@/lib/remote-route"
import { directInfoQuery, remoteRouteKeys, useClientRouteStatus } from "@/lib/remote-route-queries"

const MODES: DirectRouteMode[] = ["auto", "direct", "broker"]

const MODE_LABELS = defineMessages({
  auto: { id: "mobile.more.connection.auto", defaultMessage: "Auto" },
  direct: { id: "mobile.more.connection.direct", defaultMessage: "Direct only" },
  broker: { id: "mobile.more.connection.broker", defaultMessage: "Broker only" },
})

/**
 * How this device reaches the selected machine: directly over Tailscale when
 * the machine shares an address (remote-route.ts), or through Broker.
 */
export function MobileConnectionSetting({ nodeId }: { nodeId: string }) {
  const intl = useIntl()
  const queryClient = useQueryClient()
  const { data: status, isFetching } = useClientRouteStatus(nodeId)
  const mode = status?.mode ?? "auto"

  const changeMode = useMutation({
    mutationFn: async (next: DirectRouteMode) => {
      const info = () => queryClient.fetchQuery({ ...directInfoQuery(nodeId), staleTime: 0 })
      if (next === "direct" && !status?.address) {
        if (!(await info()).address) throw new Error(intl.formatMessage({
          id: "mobile.more.connection.addressMissing",
          defaultMessage: "To connect directly, turn on Direct connections in Settings → Remote on your computer and open Tailscale on both devices.",
        }))
      }
      setRouteMode(nodeId, next)
      if (next !== "direct") await info()
    },
    onError: (error) => { toast.error(error.message) },
    onSettled: () => queryClient.invalidateQueries({ queryKey: remoteRouteKeys.status(nodeId) }),
  })

  // Without an account there is no Broker to choose.
  const accountless = isAccountless()

  return (
    <div className="space-y-2">
      {accountless ? (
        <p className="px-1 text-xs text-muted-foreground">
          <FormattedMessage
            id="mobile.more.connection.accountless"
            defaultMessage="Without an account, this device reaches the machine over Tailscale only."
          />
        </p>
      ) : (
      <div className="flex rounded-lg bg-muted/40 p-0.5">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            disabled={changeMode.isPending}
            onClick={() => changeMode.mutate(m)}
            className={cn(
              "flex-1 rounded-md py-1.5 text-[13px] font-medium transition-colors",
              mode === m
                ? "bg-background text-foreground shadow-card"
                : "text-muted-foreground/70 hover:text-muted-foreground"
            )}
          >
            {intl.formatMessage(MODE_LABELS[m])}
          </button>
        ))}
      </div>
      )}
      <div className="space-y-0.5 px-1 text-xs text-muted-foreground">
        {isFetching && status?.error ? (
          <p><FormattedMessage id="mobile.more.connection.checking" defaultMessage="Checking connection…" /></p>
        ) : status?.route === "direct" ? (
          <p className="text-status-ok">
            <FormattedMessage id="mobile.more.connection.viaDirect" defaultMessage="Your phone connects directly to your computer over Tailscale." />
          </p>
        ) : accountless || mode === "direct" ? (
          <p className="text-status-warn">
            <FormattedMessage id="mobile.more.connection.unreachable" defaultMessage="Can’t reach your computer directly. Check that Tailscale is running on both devices." />
          </p>
        ) : mode === "auto" ? (
          <p>
            <FormattedMessage
              id="mobile.more.connection.autoRelay"
              defaultMessage="Your phone tries to connect directly to your computer. If it can’t, Operon relays the connection."
            />
          </p>
        ) : (
          <p>
            <FormattedMessage id="mobile.more.connection.viaBroker" defaultMessage="Operon relays the connection between your phone and your computer." />
          </p>
        )}
        {status?.address && <p className="truncate font-mono text-[11px] text-muted-foreground/70">{status.address}</p>}
        {!isFetching && mode === "direct" && status?.error && <p className="text-status-warn">{status.error}</p>}
      </div>
    </div>
  )
}
