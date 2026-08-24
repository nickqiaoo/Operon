import { useEffect, useMemo, useState } from "react"
import { Plus, Pencil, Trash2, Loader2, AlertCircle, Eye, EyeOff, XIcon, Hash, Send, MessageCircle, Zap } from "lucide-react"
import { SlackQuickSetupDialog } from "./SlackQuickSetupDialog"
import { TelegramQuickSetupDialog } from "./TelegramQuickSetupDialog"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { FormattedMessage, useIntl } from "react-intl"
import { api } from "@/lib/api"
import type {
  IMChannelBinding,
  IMCredentialField,
  IMProviderCreateInput,
  IMProviderRecord,
  IMProviderMode,
  IMSource,
  IMSourceMeta,
} from "@/types/im"
import type { Agent } from "@/types/channel"

type FormState = {
  source: IMSource
  mode: IMProviderMode
  agentId: number | null
  displayName: string
  enabled: boolean
  credentials: Record<string, string>
}

const FALLBACK_ICON: LucideIcon = MessageCircle
const ICON_REGISTRY: Record<string, LucideIcon> = {
  Hash,
  Send,
  MessageCircle,
}

const inputCn =
  "w-full px-3 py-2 text-sm bg-background/80 rounded-xl border border-border/50 focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40"

const tokenCn = inputCn + " font-mono pr-10"

function emptyForm(source: IMSource = "slack"): FormState {
  return {
    source,
    mode: "mate",
    agentId: null,
    displayName: "",
    enabled: true,
    credentials: {},
  }
}

export function IMPlatformSettings() {
  const intl = useIntl()
  const [providers, setProviders] = useState<IMProviderRecord[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [sources, setSources] = useState<IMSourceMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<IMProviderRecord | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  const [bindingsOpen, setBindingsOpen] = useState<IMProviderRecord | null>(null)
  const [quickSetupOpen, setQuickSetupOpen] = useState(false)
  const [tgQuickSetupOpen, setTgQuickSetupOpen] = useState(false)

  const agentsById = useMemo(() => {
    const map = new Map<number, Agent>()
    for (const a of agents) map.set(a.id, a)
    return map
  }, [agents])

  const sourceMetaByKey = useMemo(() => {
    const map = new Map<IMSource, IMSourceMeta>()
    for (const s of sources) map.set(s.source, s)
    return map
  }, [sources])

  const activeSourceMeta: IMSourceMeta | undefined = sourceMetaByKey.get(form.source)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [{ providers: list }, { agents: agentList }, { sources: sourceList }] =
        await Promise.all([
          api.imProviderList(),
          api.agentList(),
          api.imSourceList(),
        ])
      setProviders(list)
      setAgents(agentList)
      setSources(sourceList)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  function iconFor(name: string): LucideIcon {
    return ICON_REGISTRY[name] ?? FALLBACK_ICON
  }

  function openCreate() {
    const first = sources[0]?.source ?? "slack"
    setEditing(null)
    setForm(emptyForm(first))
    setFormError(null)
    setRevealed({})
    setFormOpen(true)
  }

  function openEdit(record: IMProviderRecord) {
    const creds = safeParseCreds(record.credentialsJson)
    const meta = sourceMetaByKey.get(record.source)
    const credentials: Record<string, string> = {}
    if (meta) {
      for (const field of meta.credentialFields) {
        const raw = creds[field.key]
        credentials[field.key] = typeof raw === "string" ? raw : ""
      }
    } else {
      for (const [k, v] of Object.entries(creds)) {
        if (typeof v === "string") credentials[k] = v
      }
    }
    setEditing(record)
    setForm({
      source: record.source,
      mode: record.mode,
      agentId: record.agentId,
      displayName: record.displayName,
      enabled: record.enabled,
      credentials,
    })
    setFormError(null)
    setRevealed({})
    setFormOpen(true)
  }

  function closeForm() {
    setFormOpen(false)
    setEditing(null)
    setRevealed({})
  }

  function setSource(nextSource: IMSource) {
    if (editing) return
    setForm((f) => ({ ...f, source: nextSource, credentials: {} }))
    setRevealed({})
  }

  function setCredential(key: string, value: string) {
    setForm((f) => ({ ...f, credentials: { ...f.credentials, [key]: value } }))
  }

  async function handleSave() {
    if (!form.displayName.trim()) {
      setFormError(intl.formatMessage({ id: "settings.im.error.nameRequired", defaultMessage: "display name is required" }))
      return
    }
    if (form.mode === "mate" && !form.agentId) {
      setFormError(intl.formatMessage({ id: "settings.im.error.mateNeedsAgent", defaultMessage: "mate mode requires an agent" }))
      return
    }
    if (form.mode === "interactive" && form.agentId) {
      setFormError(intl.formatMessage({ id: "settings.im.error.interactiveNoAgent", defaultMessage: "interactive mode must not have an agent" }))
      return
    }

    const meta = sourceMetaByKey.get(form.source)
    if (!meta) {
      setFormError(intl.formatMessage({ id: "settings.im.error.unsupportedSource", defaultMessage: "unsupported source: {source}" }, { source: form.source }))
      return
    }

    const credsOut: Record<string, string> = {}
    for (const field of meta.credentialFields) {
      const value = (form.credentials[field.key] ?? "").trim()
      if (field.required && !value) {
        setFormError(intl.formatMessage({ id: "settings.im.error.fieldRequired", defaultMessage: "{label} is required" }, { label: field.label }))
        return
      }
      if (value) credsOut[field.key] = value
    }
    const credentialsJson = JSON.stringify(credsOut)
    const isMate = form.mode === "mate"
    // Preserve any existing provider config as-is.
    const configJson = editing?.configJson ?? JSON.stringify({})

    setSaving(true)
    setFormError(null)
    try {
      if (editing) {
        await api.imProviderUpdate(editing.id, {
          agentId: isMate ? form.agentId : null,
          displayName: form.displayName.trim(),
          credentialsJson,
          configJson,
          enabled: form.enabled,
        })
      } else {
        const payload: Omit<IMProviderCreateInput, "instanceId" | "selfUserId"> = {
          source: form.source,
          mode: form.mode,
          agentId: isMate ? form.agentId : null,
          displayName: form.displayName.trim(),
          credentialsJson,
          configJson,
          enabled: form.enabled,
        }
        await api.imProviderCreate(payload as IMProviderCreateInput)
      }
      closeForm()
      await refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(record: IMProviderRecord) {
    await api.imProviderUpdate(record.id, { enabled: !record.enabled })
    await refresh()
  }

  async function handleDelete(record: IMProviderRecord) {
    if (!window.confirm(intl.formatMessage(
      { id: "settings.im.confirmDelete", defaultMessage: 'Delete provider "{name}"?' },
      { name: record.displayName }
    ))) return
    await api.imProviderDelete(record.id)
    await refresh()
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold mb-1">
          <FormattedMessage id="settings.im.title" defaultMessage="IM Platform" />
        </h2>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="settings.im.desc"
            defaultMessage="Register IM bots as first-class providers. In {mate} mode a bot embodies an agent and joins channels; in {interactive} mode it runs the wizard flow. Source and mode are locked after creation — delete and recreate to switch."
            values={{
              mate: <span className="font-mono">mate</span>,
              interactive: <span className="font-mono">interactive</span>,
            }}
          />
        </p>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground/60">
          <FormattedMessage
            id="settings.im.providerCount"
            defaultMessage="{count, plural, one {# provider} other {# providers}}"
            values={{ count: providers.length }}
          />
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setQuickSetupOpen(true)}
            className="h-8 gap-1.5"
            disabled={sources.length === 0 || agents.length === 0}
            title={agents.length === 0
              ? intl.formatMessage({ id: "settings.im.createAgentFirst", defaultMessage: "Create an agent first" })
              : intl.formatMessage({ id: "settings.im.slackQuickSetupTitle", defaultMessage: "Auto-create a Slack app via manifest API" })
            }
          >
            <Zap className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.im.slackQuickSetup" defaultMessage="Slack Quick Setup" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setTgQuickSetupOpen(true)}
            className="h-8 gap-1.5"
            disabled={sources.length === 0 || agents.length === 0}
            title={agents.length === 0
              ? intl.formatMessage({ id: "settings.im.createAgentFirst", defaultMessage: "Create an agent first" })
              : intl.formatMessage({ id: "settings.im.tgQuickSetupTitle", defaultMessage: "Paste a BotFather token, we configure the rest" })
            }
          >
            <Zap className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.im.tgQuickSetup" defaultMessage="Telegram Quick Setup" />
          </Button>
          <Button size="sm" variant="secondary" onClick={openCreate} className="h-8 gap-1.5" disabled={sources.length === 0}>
            <Plus className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.im.newProvider" defaultMessage="New provider" />
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <FormattedMessage id="settings.im.loading" defaultMessage="Loading..." />
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/50 bg-muted/10 p-8 text-center text-sm text-muted-foreground">
          <FormattedMessage id="settings.im.empty" defaultMessage="No IM providers yet. Create one to connect a bot." />
        </div>
      ) : (
        <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden">
          {providers.map((p) => {
            const meta = sourceMetaByKey.get(p.source)
            const Icon = iconFor(meta?.icon ?? "")
            const label = meta?.label ?? p.source
            const agent = p.agentId != null ? agentsById.get(p.agentId) : null
            return (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors group">
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-tint/15 shrink-0">
                  <Icon className="w-4 h-4 text-tint" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>{p.displayName}</span>
                    {!p.enabled && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground">
                        <FormattedMessage id="settings.im.disabled" defaultMessage="disabled" />
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground/60 truncate">
                    {label}{" · "}
                    <FormattedMessage id="settings.im.mode" defaultMessage="mode: {mode}" values={{ mode: <span className="font-mono">{p.mode}</span> }} />
                    {p.mode === "mate" && (
                      <>
                        {" · "}
                        <FormattedMessage id="settings.im.agentInfo" defaultMessage="agent: {name}" values={{ name: <span className="font-mono">{agent?.name ?? `#${p.agentId}`}</span> }} />
                      </>
                    )}
                    {p.selfUserId && (
                      <>
                        {" · "}
                        <FormattedMessage id="settings.im.botId" defaultMessage="bot id: {id}" values={{ id: <span className="font-mono">{p.selfUserId}</span> }} />
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => setBindingsOpen(p)}
                    className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
                    title={intl.formatMessage({ id: "settings.im.viewBindings", defaultMessage: "View channel bindings" })}
                  >
                    <FormattedMessage id="settings.im.bindings" defaultMessage="Bindings" />
                  </button>
                  <Switch
                    checked={p.enabled}
                    onCheckedChange={() => void handleToggle(p)}
                    title={p.enabled
                      ? intl.formatMessage({ id: "settings.im.disable", defaultMessage: "Disable" })
                      : intl.formatMessage({ id: "settings.im.enable", defaultMessage: "Enable" })
                    }
                    className="mx-1"
                  />
                  <button
                    onClick={() => openEdit(p)}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
                    title={intl.formatMessage({ id: "settings.im.editTitle", defaultMessage: "Edit" })}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => void handleDelete(p)}
                    className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                    title={intl.formatMessage({ id: "settings.im.deleteTitle", defaultMessage: "Delete" })}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Dialog open={formOpen} onOpenChange={(v) => { if (!v) closeForm() }}>
        <DialogContent
          className="max-h-[85vh] max-w-lg overflow-hidden flex flex-col"
          showCloseButton={false}
        >
          <DialogHeader className="px-1 pt-1 pb-4 flex flex-row items-center justify-between shrink-0">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              {editing
                ? <FormattedMessage id="settings.im.editDialog.title" defaultMessage="Edit IM Provider" />
                : <FormattedMessage id="settings.im.newDialog.title" defaultMessage="New IM Provider" />
              }
            </DialogTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/50" onClick={closeForm}>
              <XIcon className="h-4 w-4" />
            </Button>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 code-scrollbar">
            <div className="space-y-5 pb-2">
              <Field
                label={intl.formatMessage({ id: "settings.im.field.source", defaultMessage: "Source" })}
                hint={editing ? intl.formatMessage({ id: "settings.im.field.sourceLocked", defaultMessage: "Locked — delete the provider to change its source." }) : undefined}
              >
                <Select
                  value={form.source}
                  onValueChange={(v) => setSource(v as IMSource)}
                  disabled={!!editing}
                >
                  <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[80]">
                    {sources.map((s) => (
                      <SelectItem key={s.source} value={s.source}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field
                label={intl.formatMessage({ id: "settings.im.field.displayName", defaultMessage: "Display Name" })}
                hint={intl.formatMessage({ id: "settings.im.field.displayNameHint", defaultMessage: "Shown in UIs and prompts. Used to derive an internal id." })}
              >
                <input
                  className={inputCn}
                  value={form.displayName}
                  onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                  placeholder="Code Writer"
                />
              </Field>

              <Field
                label={intl.formatMessage({ id: "settings.im.field.mode", defaultMessage: "Mode" })}
                hint={editing ? intl.formatMessage({ id: "settings.im.field.modeLocked", defaultMessage: "Locked — delete the provider to switch mode." }) : undefined}
              >
                <Select
                  value={form.mode}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, mode: v as IMProviderMode, agentId: v === "interactive" ? null : f.agentId }))
                  }
                  disabled={!!editing}
                >
                  <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[80]">
                    <SelectItem value="mate">
                      <FormattedMessage id="settings.im.mode.mate" defaultMessage="mate — agent-as-bot, joins channels" />
                    </SelectItem>
                    <SelectItem value="interactive">
                      <FormattedMessage id="settings.im.mode.interactive" defaultMessage="interactive — wizard-style DM bot" />
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              {form.mode === "mate" && (
                <Field
                  label={intl.formatMessage({ id: "settings.im.field.agent", defaultMessage: "Agent" })}
                  hint={intl.formatMessage({ id: "settings.im.field.agentHint", defaultMessage: "The operon agent this bot embodies. Required for mate mode." })}
                >
                  <Select
                    value={form.agentId != null ? String(form.agentId) : ""}
                    onValueChange={(v) => setForm((f) => ({ ...f, agentId: v ? Number(v) : null }))}
                  >
                    <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 shadow-none">
                      <SelectValue placeholder={agents.length === 0
                        ? intl.formatMessage({ id: "settings.im.noAgents", defaultMessage: "No agents available" })
                        : intl.formatMessage({ id: "settings.im.selectAgent", defaultMessage: "Select an agent" })
                      } />
                    </SelectTrigger>
                    <SelectContent className="z-[80]">
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name} <span className="text-muted-foreground">· {a.provider}/{a.model}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}

              {form.mode === "mate" && (
                <p className="text-xs text-muted-foreground px-1">
                  <FormattedMessage
                    id="settings.im.mateWorkspaceHint"
                    defaultMessage="Workspace is picked per channel on first message via an in-chat setup prompt."
                  />
                </p>
              )}

              {activeSourceMeta?.credentialFields.map((field) => (
                <CredentialField
                  key={field.key}
                  field={field}
                  value={form.credentials[field.key] ?? ""}
                  onChange={(v) => setCredential(field.key, v)}
                  revealed={!!revealed[field.key]}
                  onToggleReveal={() =>
                    setRevealed((r) => ({ ...r, [field.key]: !r[field.key] }))
                  }
                />
              ))}

              <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                />
                <FormattedMessage id="settings.im.enabledLabel" defaultMessage="Enabled — start this provider on save" />
              </label>

              {formError && (
                <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {formError}
                </div>
              )}
            </div>
          </div>

          <div className="pt-4 mt-4 border-t border-border/40 shrink-0 flex justify-end gap-2">
            <Button variant="ghost" onClick={closeForm} className="hover:bg-muted/50">
              <FormattedMessage id="settings.im.cancel" defaultMessage="Cancel" />
            </Button>
            <Button variant="secondary" onClick={() => void handleSave()} disabled={saving} className="px-6">
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {editing
                ? <FormattedMessage id="settings.im.saveChanges" defaultMessage="Save Changes" />
                : <FormattedMessage id="settings.im.create" defaultMessage="Create" />
              }
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <BindingsDialog
        provider={bindingsOpen}
        agentsById={agentsById}
        onClose={() => setBindingsOpen(null)}
      />

      <SlackQuickSetupDialog
        open={quickSetupOpen}
        onClose={() => setQuickSetupOpen(false)}
        onCreated={() => void refresh()}
        agents={agents}
      />

      <TelegramQuickSetupDialog
        open={tgQuickSetupOpen}
        onClose={() => setTgQuickSetupOpen(false)}
        onCreated={() => void refresh()}
        agents={agents}
      />
    </div>
  )
}

function CredentialField({
  field,
  value,
  onChange,
  revealed,
  onToggleReveal,
}: {
  field: IMCredentialField
  value: string
  onChange: (v: string) => void
  revealed: boolean
  onToggleReveal: () => void
}) {
  return (
    <Field label={field.label} hint={field.helpText}>
      <div className="relative">
        <input
          className={field.secret ? tokenCn : inputCn}
          type={field.secret && !revealed ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
          autoComplete="off"
        />
        {field.secret && <RevealToggle show={revealed} onToggle={onToggleReveal} />}
      </div>
    </Field>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground/60">{hint}</p>}
    </div>
  )
}

function RevealToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
    >
      {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
    </button>
  )
}

function BindingsDialog({
  provider,
  agentsById,
  onClose,
}: {
  provider: IMProviderRecord | null
  agentsById: Map<number, Agent>
  onClose: () => void
}) {
  const [bindings, setBindings] = useState<IMChannelBinding[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!provider) return
    setLoading(true)
    api
      .imBindingsForProvider(provider.id)
      .then(({ bindings: list }) => setBindings(list))
      .catch(() => setBindings([]))
      .finally(() => setLoading(false))
  }, [provider])

  return (
    <Dialog open={!!provider} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        className="max-h-[75vh] max-w-md overflow-hidden flex flex-col"
        showCloseButton={false}
      >
        <DialogHeader className="px-1 pt-1 pb-2 flex flex-row items-center justify-between shrink-0">
          <div>
            <DialogTitle className="text-lg font-semibold tracking-tight">
              <FormattedMessage id="settings.im.bindingsDialog.title" defaultMessage="Channel Bindings" />
            </DialogTitle>
            <p className="text-xs text-muted-foreground/60 mt-0.5">
              {provider ? provider.displayName : ""}{" · "}
              <FormattedMessage id="settings.im.bindingsDialog.readOnly" defaultMessage="read-only" />
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/50" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 pb-2 code-scrollbar">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <FormattedMessage id="settings.im.loading" defaultMessage="Loading..." />
            </div>
          ) : bindings.length === 0 ? (
            <div className="text-sm text-muted-foreground/60 py-6 text-center">
              <FormattedMessage
                id="settings.im.bindingsDialog.empty"
                defaultMessage="No bindings yet. Bindings appear when the bot is invited to a channel or receives a DM."
              />
            </div>
          ) : (
            <div className="space-y-1">
              {bindings.map((b) => {
                const agent = agentsById.get(b.agentId)
                return (
                  <div key={b.id} className="rounded-lg px-3 py-2 bg-muted/20 text-xs space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-foreground">{b.sourceChannelName ?? b.sourceChannel}</span>
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground">
                        {b.channelKind}
                      </span>
                    </div>
                    <div className="text-muted-foreground/70">
                      <FormattedMessage
                        id="settings.im.bindingsDialog.agentAdded"
                        defaultMessage="agent: {agent} · added {date}"
                        values={{ agent: agent?.name ?? `#${b.agentId}`, date: formatDate(b.createdAt) }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function safeParseCreds(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString()
}
