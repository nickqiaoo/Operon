import { useCallback, useEffect, useMemo, useState } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { AlertTriangle, Check, Loader2, MessageSquare, Plus, RefreshCw, Trash2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api } from "@/lib/api"
import { DisbandConfirmDialog } from "@/components/editor/agent/DisbandConfirmDialog"
import { cn } from "@/lib/utils"
import { useEditorStore } from "@/stores/editor-store"
import type { PeerMemberStatus, PeersConfig, PeersRosterDTO, PeerTeamDTO, TeammateTypeConfig } from "@/types/peers"

/**
 * Teams: the configuration view of the Operon Teams extension, reached from its row in
 * Settings → Extensions. An Operon chat can form a team and spawn teammates (independent
 * sessions that message each other and report back); each teammate shows up as its own
 * conversation. This page owns what a teammate TYPE is (title / role / model / permission
 * mode / instructions) and the fleet budget; saving reloads the extension, so sessions
 * opened afterwards see the new set. On/off is the extension's Load / Unload.
 */
export function TeamsSettings() {
  const intl = useIntl()
  const [config, setConfig] = useState<PeersConfig | null>(null)
  const [saved, setSaved] = useState<PeersConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roster, setRoster] = useState<PeersRosterDTO | null>(null)
  const [rosterLoading, setRosterLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.peersConfig()
      if (res.error) throw new Error(res.error)
      if (res.config) {
        setConfig(res.config)
        setSaved(res.config)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

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
    void load()
    void loadRoster()
  }, [load, loadRoster])

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(saved), [config, saved])

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

  const save = useCallback(async () => {
    if (!config) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.peersConfigSave(config)
      if (res.error) throw new Error(res.error)
      if (res.config) {
        setConfig(res.config)
        setSaved(res.config)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [config])

  const update = (patch: (c: PeersConfig) => PeersConfig) => setConfig((c) => (c ? patch(c) : c))
  const updateType = (id: string, patch: Partial<TeammateTypeConfig>) =>
    update((c) => ({ ...c, types: { ...c.types, [id]: { ...c.types[id]!, ...patch } } }))

  const [newTypeId, setNewTypeId] = useState("")
  const addType = () => {
    const id = newTypeId.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || config?.types[id]) return
    update((c) => ({ ...c, types: { ...c.types, [id]: { title: id, modeId: "workspace" } } }))
    setNewTypeId("")
  }

  if (loading && !config) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }

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
      <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
        <div className="flex items-start gap-3">
          <Users className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h3 className="mb-1 text-sm font-semibold">
              <FormattedMessage id="settings.teams.title" defaultMessage="Teams" />
            </h3>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.teams.desc"
                defaultMessage="Let an Operon chat form a team and spawn teammates — independent sessions that work in parallel, message each other, and report back. Each teammate appears as its own conversation."
              />
            </p>
          </div>
        </div>

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

        {config && (
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
            <span className="font-medium">
              <FormattedMessage id="settings.teams.maxWakes" defaultMessage="Max wakes" />
            </span>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={config.budget.maxWakes ?? ""}
                placeholder="unlimited"
                className="h-8 w-40 border-border/50 text-xs"
                onChange={(e) => update((c) => ({ ...c, budget: { ...c.budget, maxWakes: e.target.value ? Number(e.target.value) : undefined } }))}
              />
              <span className="text-[11px]">
                <FormattedMessage id="settings.teams.maxWakesHint" defaultMessage="Each peer message that starts a turn on an idle teammate is one wake — a fresh model call nobody asked for." />
              </span>
            </div>
            <span className="font-medium">
              <FormattedMessage id="settings.teams.maxTokens" defaultMessage="Max tokens" />
            </span>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={config.budget.maxTotalTokens ?? ""}
                placeholder="unlimited"
                className="h-8 w-40 border-border/50 text-xs"
                onChange={(e) => update((c) => ({ ...c, budget: { ...c.budget, maxTotalTokens: e.target.value ? Number(e.target.value) : undefined } }))}
              />
              <span className="text-[11px]">
                <FormattedMessage id="settings.teams.maxTokensHint" defaultMessage="Fleet-wide. Reaching either cap pauses spawns and messages; running teammates finish their own work." />
              </span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" className="h-8 gap-1.5" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            <FormattedMessage id="settings.teams.save" defaultMessage="Save" />
          </Button>
          {dirty && (
            <span className="text-[11px] text-muted-foreground">
              <FormattedMessage id="settings.teams.applyHint" defaultMessage="Applies live; conversations already open keep their current tools." />
            </span>
          )}
        </div>
      </div>

      {config && (
        <div className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
          <div className="flex items-start gap-3">
            <Users className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <h3 className="mb-1 text-sm font-semibold">
                <FormattedMessage id="settings.teams.typesTitle" defaultMessage="Teammate types" />
              </h3>
              <p className="text-xs text-muted-foreground">
                <FormattedMessage
                  id="settings.teams.typesDesc"
                  defaultMessage="What a lead can spawn. The model only picks a type and a name; everything else — role, model, permission mode, instructions — is decided here."
                />
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {Object.entries(config.types).map(([id, t]) => (
              <TypeCard
                key={id}
                id={id}
                value={t}
                onChange={(patch) => updateType(id, patch)}
                onRemove={() =>
                  update((c) => {
                    const next = { ...c.types }
                    delete next[id]
                    return { ...c, types: next }
                  })
                }
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={newTypeId}
              onChange={(e) => setNewTypeId(e.target.value)}
              placeholder={intl.formatMessage({ id: "settings.teams.newTypePlaceholder", defaultMessage: "new type id, e.g. tester" })}
              className="h-8 max-w-[240px] border-border/50 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") addType()
              }}
            />
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={addType} disabled={!newTypeId.trim()}>
              <Plus className="h-3.5 w-3.5" /> <FormattedMessage id="settings.teams.addType" defaultMessage="Add type" />
            </Button>
          </div>
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

const MODES = ["manual", "workspace", "auto", "yolo"] as const

function TypeCard({ id, value, onChange, onRemove }: { id: string; value: TeammateTypeConfig; onChange: (patch: Partial<TeammateTypeConfig>) => void; onRemove: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-border/40 bg-background/40 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{id}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-status-error" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="font-medium">Title</span>
        <Input value={value.title} className="h-8 max-w-[280px] border-border/50 text-xs" onChange={(e) => onChange({ title: e.target.value })} />
        <span className="font-medium">Role</span>
        <Input
          value={value.description ?? ""}
          placeholder="One line the lead sees on the roster"
          className="h-8 border-border/50 text-xs"
          onChange={(e) => onChange({ description: e.target.value || undefined })}
        />
        <span className="font-medium">Model</span>
        <Input
          value={value.modelId ?? ""}
          placeholder="provider/model — empty = the lead's model"
          className="h-8 max-w-[320px] border-border/50 text-xs"
          onChange={(e) => onChange({ modelId: e.target.value || undefined })}
        />
        <span className="font-medium">Permissions</span>
        <Select value={value.modeId ?? "workspace"} onValueChange={(modeId) => onChange({ modeId })}>
          <SelectTrigger className="h-8 w-full max-w-[200px] border-border/50 bg-background/80 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m} value={m} className="text-xs">
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="self-start pt-2 font-medium">Instructions</span>
        <Textarea
          value={value.instructions ?? ""}
          placeholder="Appended to the teammate's system prompt"
          className="min-h-[60px] border-border/50 text-xs"
          onChange={(e) => onChange({ instructions: e.target.value || undefined })}
        />
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
