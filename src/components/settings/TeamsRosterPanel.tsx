import { useCallback, useEffect, useState } from "react"
import { FormattedMessage } from "react-intl"
import { AlertTriangle, Loader2, MessageSquare, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { DisbandConfirmDialog } from "@/components/editor/agent/DisbandConfirmDialog"
import { cn } from "@/lib/utils"
import { useEditorStore } from "@/stores/editor-store"
import type { PeerMemberStatus, PeersRosterDTO, PeerTeamDTO } from "@/types/peers"

/**
 * Teams: the runtime view of the Operon Teams extension, shown under its settings form in
 * Settings → Extensions → Teams. Its settings (teammate types, budget) are the extension's own and
 * are rendered by the generic form; this is what those settings cannot show — the teams running
 * right now, their spend, and disbanding a finished one.
 */
export function TeamsRosterPanel() {
  const [error, setError] = useState<string | null>(null)
  const [roster, setRoster] = useState<PeersRosterDTO | null>(null)
  const [rosterLoading, setRosterLoading] = useState(false)

  const loadRoster = useCallback(async () => {
    setRosterLoading(true)
    try {
      const res = await api.peersRoster()
      if (res.error) throw new Error(res.error)
      setRoster(res)
    } catch {
      setRoster(null)
    } finally {
      setRosterLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRoster()
  }, [loadRoster])

  // Disband = take the members off the roster (freeing their names) and close their sessions.
  const [disbanding, setDisbanding] = useState<string | null>(null)
  /** Team awaiting confirmation. Same gate as the session panel's — this list reaches
   *  every team on the machine, so an accidental click here is the more expensive one. */
  const [confirming, setConfirming] = useState<PeerTeamDTO | null>(null)
  const disband = useCallback(
    async (label: string) => {
      setDisbanding(label)
      try {
        const res = await api.peersDisband(label)
        if (res.error) throw new Error(res.error)
        await loadRoster()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setDisbanding(null)
      }
    },
    [loadRoster],
  )

  return (
    <div className="space-y-6">
      <DisbandConfirmDialog
        team={confirming}
        onOpenChange={(open) => !open && setConfirming(null)}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const label = confirming?.label
          setConfirming(null)
          if (label) void disband(label)
        }}
      />
      {roster && !roster.available && (
        <div className="flex items-center gap-2 text-xs text-status-warn">
          <AlertTriangle className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.teams.notLoaded" defaultMessage="The Teams extension is not loaded. Load it from the Extensions list to give new conversations the Team tool; settings here are kept for when it is." />
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </div>
      )}
      <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
        <div className="flex items-start gap-3">
          <MessageSquare className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h3 className="mb-1 text-sm font-semibold">
              <FormattedMessage id="settings.teams.rosterTitle" defaultMessage="Active teams" />
            </h3>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.teams.rosterDesc"
                defaultMessage="Every team on this machine, across workspaces. Open a member to read or steer its conversation. Disband a finished team to close its sessions and free its names."
              />
            </p>
          </div>
          <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => void loadRoster()} disabled={rosterLoading}>
            {rosterLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <FormattedMessage id="settings.teams.refresh" defaultMessage="Refresh" />
          </Button>
        </div>
        {roster?.stats && (
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
            <span className="font-medium">Wakes</span>
            <span>
              {roster.stats.totals.wakes}
              {roster.stats.budget.maxWakes ? ` / ${roster.stats.budget.maxWakes}` : ""}
            </span>
            <span className="font-medium">Tokens</span>
            <span>
              {roster.stats.totals.totalTokens.toLocaleString()}
              {roster.stats.budget.maxTotalTokens ? ` / ${roster.stats.budget.maxTotalTokens.toLocaleString()}` : ""}
            </span>
            <span className="font-medium">Messages</span>
            <span>{roster.stats.totals.messagesSent}</span>
            {roster.stats.exceeded && (
              <>
                <span className="font-medium text-status-warn">Paused</span>
                <span className="text-status-warn">{roster.stats.exceeded}</span>
              </>
            )}
          </div>
        )}
        {!roster || roster.teams.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/50 px-4 py-6 text-center text-xs text-muted-foreground">
            {roster && !roster.available ? (
              <FormattedMessage id="settings.teams.unavailable" defaultMessage="Nothing to show while the extension is not loaded." />
            ) : (
              <FormattedMessage id="settings.teams.rosterEmpty" defaultMessage="No teams yet. Ask an Operon chat to form a team and spawn teammates." />
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/40 rounded-lg border border-border/40 bg-background/40">
            {roster.teams.map((team) => (
              <div key={team.label} className="px-4 py-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{team.name}</span>
                  {team.leadStatus && <StatusDot status={team.leadStatus} />}
                  {team.leadChatId != null && (
                    <button type="button" className="text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => openChat(team.leadChatId!, team.name)}>
                      <FormattedMessage id="settings.teams.openLead" defaultMessage="Open lead" />
                    </button>
                  )}
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-status-error"
                    disabled={disbanding === team.label}
                    onClick={() => setConfirming(team)}
                  >
                    {disbanding === team.label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    <FormattedMessage id="settings.teams.disband" defaultMessage="Disband" />
                  </Button>
                </div>
                <div className="mt-1.5 space-y-1">
                  {team.members.map((m) => (
                    <div key={m.sessionId} className="flex items-center gap-2 text-xs">
                      <StatusDot status={m.status} />
                      <span className="font-medium">{m.name}</span>
                      <span className="text-muted-foreground">{m.typeTitle}</span>
                      {m.pendingApprovals > 0 && <span className="text-status-warn">needs approval</span>}
                      <span className="flex-1" />
                      {m.chatId != null && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => openChat(m.chatId!, `${m.name} · ${m.typeTitle}`)}>
                          <FormattedMessage id="settings.teams.open" defaultMessage="Open" />
                        </Button>
                      )}
                    </div>
                  ))}
                  {team.members.length === 0 && (
                    <div className="text-xs text-muted-foreground">
                      <FormattedMessage id="settings.teams.noMembers" defaultMessage="No teammates spawned yet." />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const STATUS_DOT: Record<PeerMemberStatus, string> = {
  running: "bg-status-info animate-pulse",
  idle: "bg-status-ok",
  parked: "bg-muted-foreground/40",
  error: "bg-status-error",
}

function StatusDot({ status }: { status: PeerMemberStatus }) {
  return <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[status])} title={status} />
}

/** Open a chat row as an editor tab (the same path the history popover takes). */
export function openChat(chatId: number, title: string): void {
  const tabId = `chat:${chatId}`
  const store = useEditorStore.getState()
  store.openChatTab(tabId, title, undefined, "custom")
  store.setTabChatId(tabId, chatId)
}
