import { ChannelDialog } from './ChannelDialog'
import { toast } from 'sonner'
import { useIsMobileShell } from '@/hooks/useIsMobile'
import { useEffect, useMemo, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Plus, Pencil, Trash2, Bot, XIcon, X, Info, ChevronRight, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorShortcut,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector'
import { useModelManagement } from '@/components/editor/hooks/useModelManagement'
import { useChannelStore } from '@/stores/channel-store'
import { api } from '@/lib/api'
import { useProviders } from '@/lib/provider-queries'
import { cn } from '@/lib/utils'
import { scopeLabel } from './channel-i18n'
import { countLive, BindingCountBadge, BindingRow } from './binding-ui'
import type { Agent, AgentBinding, AgentEnvVar } from '@/types/channel'
import { useRowKeys } from '@/hooks/useRowKeys'

interface AgentManageDialogProps {
  open: boolean
  onClose: () => void
  /** The agents a persona can run on. Left out, the dialog asks the server itself when it opens. */
  providers?: { id: string; label: string }[]
}

interface AgentFormState {
  name: string
  provider: string
  model: string
  instructions: string
  permissionMode: string
  /** '' = the provider's default effort. */
  thinkingLevel: string
  env: AgentEnvVar[]
}

const EMPTY_FORM: AgentFormState = {
  name: '', provider: '', model: '', instructions: '', permissionMode: '', thinkingLevel: '', env: [],
}

const FIELD_LABEL = 'block text-xs font-medium text-muted-foreground'
/** Text fields in this form: a quiet outline on the dialog surface, no fill, no shadow. */
const FIELD_SURFACE = 'bg-transparent border-border/50 dark:border-border/35 shadow-none hover:border-border focus-visible:border-tint/40 focus-visible:ring-1 focus-visible:ring-tint/10'
/** The control on the right of a runtime row; every row uses the same width so they line up. */
const RUNTIME_TRIGGER = 'w-full min-w-0 bg-transparent border-border/50 dark:border-border/35 shadow-none hover:bg-row-hover'
/** Radix Select can't hold '' as a value; this stands for "the provider's default effort". */
const EFFORT_DEFAULT = '__default__'

const FormInput = ({ className, ...props }: React.ComponentProps<typeof Input>) => (
  <Input {...props} className={cn(FIELD_SURFACE, className)} />
)

/** One line of the runtime group: what it is (and a short note) on the left, its control on the right. */
function RuntimeRow({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground/85">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{hint}</div>}
      </div>
      <div className="w-1/2 max-w-52 min-w-0">{children}</div>
    </div>
  )
}


export function AgentManageDialog({ open, onClose, providers: givenProviders }: AgentManageDialogProps) {
  const intl = useIntl()
  const mobile = useIsMobileShell()
  // Opened from wherever an agent is picked (the board, a dispatch, a task), not just the channel
  // page that used to hand the list in.
  const { data: providerList } = useProviders({ enabled: open && !givenProviders })
  const loadedProviders = useMemo(
    () => (providerList ?? []).map((p) => ({ id: p.id, label: p.label })),
    [providerList],
  )
  const providers = givenProviders ?? loadedProviders
  const agents = useChannelStore((s) => s.agents)
  const createAgent = useChannelStore((s) => s.createAgent)
  const updateAgent = useChannelStore((s) => s.updateAgent)
  const deleteAgent = useChannelStore((s) => s.deleteAgent)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<AgentFormState>(EMPTY_FORM)
  const envKeys = useRowKeys(form.env.length)
  const [saving, setSaving] = useState(false)
  const [bindingsByAgent, setBindingsByAgent] = useState<Record<number, AgentBinding[]>>({})
  const [expandedAgentId, setExpandedAgentId] = useState<number | null>(null)
  const [resettingBinding, setResettingBinding] = useState<number | null>(null)

  const refreshBindings = async () => {
    if (agents.length === 0) { setBindingsByAgent({}); return }
    const results = await Promise.all(
      agents.map(async (a) => {
        try {
          const { sessions } = await api.agentListSessions(a.id)
          return [a.id, sessions] as const
        } catch {
          return [a.id, [] as AgentBinding[]] as const
        }
      })
    )
    setBindingsByAgent(Object.fromEntries(results))
  }

  useEffect(() => {
    if (!open) return
    void refreshBindings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agents.length])

  const handleBindingReset = async (binding: AgentBinding) => {
    const label = binding.scopeDisplayName || `${scopeLabel(intl, binding.scopeKind)}:${binding.scopeKey}`
    if (!window.confirm(intl.formatMessage(
      { id: 'channel.binding.resetConfirm', defaultMessage: 'Reset binding "{label}"? The chat session will be torn down; next message starts cold.' },
      { label },
    ))) return
    setResettingBinding(binding.id)
    try {
      await api.bindingReset(binding.id)
      await refreshBindings()
    } finally {
      setResettingBinding(null)
    }
  }

  const modelManagement = useModelManagement(form.model, form.provider || undefined)
  const { model, setModel, availableModels, selectedModel, modeOptions, currentMode, thinkingEffortOptions } = modelManagement

  useEffect(() => {
    if (!form.provider || modeOptions.length === 0) return
    setForm((current) => {
      if (!current.provider) return current
      if (modeOptions.some((option) => option.value === current.permissionMode)) {
        return current
      }
      const nextMode = currentMode || modeOptions[0]?.value || ''
      return current.permissionMode === nextMode
        ? current
        : { ...current, permissionMode: nextMode }
    })
  }, [currentMode, form.provider, modeOptions])

  // Agent-level permission modes come from the active provider descriptor.
  const permissionOptions: Array<{ value: string; label: string; description?: string }> = (() => {
    return modeOptions.map((m) => ({ value: m.value, label: m.label, description: m.description }))
  })()
  const permissionValue = form.permissionMode || currentMode || modeOptions[0]?.value || ''
  const selectedPermission = permissionOptions.find((o) => o.value === permissionValue)

  // A model that doesn't offer the saved effort falls back to the provider's default.
  useEffect(() => {
    if (!form.thinkingLevel || thinkingEffortOptions.length === 0) return
    if (thinkingEffortOptions.some((opt) => opt.value === form.thinkingLevel)) return
    setForm((f) => ({ ...f, thinkingLevel: '' }))
  }, [form.thinkingLevel, thinkingEffortOptions])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  const openEdit = (agent: Agent) => {
    setEditing(agent)
    setForm({
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      instructions: agent.instructions ?? '',
      permissionMode: agent.permissionMode || '',
      thinkingLevel: agent.thinkingLevel || '',
      env: agent.env ?? [],
    })
    setModel(agent.model)
    setFormOpen(true)
  }

  const handleFormClose = () => {
    setFormOpen(false)
    setEditing(null)
  }

  const handleSave = async () => {
    const modelId = model || form.model
    if (!form.name.trim() || !form.provider.trim() || !modelId.trim()) return
    setSaving(true)
    try {
      const permissionMode = form.permissionMode || currentMode || modeOptions[0]?.value
      // A loaded model with no effort levels (e.g. Haiku) leaves it to the provider.
      const thinkingLevel = availableModels.length > 0 && thinkingEffortOptions.length === 0 ? '' : form.thinkingLevel
      const env = form.env
        .map((e) => ({ key: e.key.trim(), value: e.value, enabled: e.enabled }))
        .filter((e) => e.key.length > 0)
      if (editing) {
        // Server rejects any update payload containing `provider` — provider
        // is locked at create time to keep native SDK session state intact.
        await updateAgent(editing.id, {
          name: form.name, model: modelId,
          instructions: form.instructions, permissionMode, thinkingLevel, env,
        })
      } else {
        await createAgent({
          name: form.name, provider: form.provider, model: modelId,
          instructions: form.instructions, permissionMode, thinkingLevel, env,
        })
      }
      setFormOpen(false)
      setEditing(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save agent')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (agent: Agent) => {
    if (!window.confirm(intl.formatMessage(
      { id: 'channel.agent.deleteConfirm', defaultMessage: 'Delete agent "{name}"?' },
      { name: agent.name },
    ))) return
    await deleteAgent(agent.id)
  }

  const isSubmitDisabled = saving || !form.name.trim() || !form.provider.trim() || !(model || form.model).trim()

  return (
    <>
      <ChannelDialog open={open && !(mobile && formOpen)} onClose={onClose} className="max-h-[75vh] max-w-md overflow-hidden flex flex-col">
        <DialogHeader className="px-1 pt-1 pb-2 flex flex-row items-center justify-between shrink-0">
          <div>
            <DialogTitle>
              <FormattedMessage id="channel.manageAgents" defaultMessage="Manage Agents" />
            </DialogTitle>
            <p className="text-xs text-muted-foreground/60 mt-0.5">
              <FormattedMessage
                id="channel.agentCount"
                defaultMessage="{count, plural, one {# agent} other {# agents}}"
                values={{ count: agents.length }}
              />
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={openCreate} className="gap-1.5 h-8 px-3 text-xs text-muted-foreground hover:text-foreground">
              <Plus className="h-3.5 w-3.5" />
              <FormattedMessage id="common.new" defaultMessage="New" />
            </Button>
            <Button aria-label="Close" variant="ghost" size="icon" className="size-11 md:size-7 rounded-md text-muted-foreground hover:text-foreground" onClick={onClose}>
              <XIcon className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto -mx-6 px-6 code-scrollbar">
          {agents.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground/50">
              <Bot className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm"><FormattedMessage id="channel.noAgents" defaultMessage="No agents yet" /></p>
              <p className="text-xs mt-0.5"><FormattedMessage id="channel.manage.emptyHint" defaultMessage="Create your first agent to get started" /></p>
            </div>
          ) : (
            <div className="space-y-1 pb-2">
              {agents.map((agent) => {
                // Offline bindings are reset/never-started residue with no lifecycle
                // that ever clears them — hide them so the list shows only sessions
                // that are actually live (active or idle).
                const liveBindings = (bindingsByAgent[agent.id] ?? []).filter((b) => b.status !== 'offline')
                const liveCount = countLive(liveBindings)
                const expanded = expandedAgentId === agent.id
                return (
                  <div key={agent.id} className="rounded-lg overflow-hidden">
                    <div className="group flex items-center gap-1 rounded-lg px-2 hover:bg-row-hover">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setExpandedAgentId(expanded ? null : agent.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left"
                      >
                        <ChevronRight
                          className={cn(
                            'h-3.5 w-3.5 text-muted-foreground/50 transition-transform shrink-0',
                            expanded && 'rotate-90',
                          )}
                        />
                        <span className="flex items-center justify-center w-8 h-8 rounded-full bg-tint/15 shrink-0">
                          <Bot className="w-4 h-4 text-tint" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground truncate">{agent.name}</span>
                            <BindingCountBadge count={liveCount} total={liveBindings.length} />
                          </span>
                          <span className="block truncate text-xs text-muted-foreground/60">
                            {agent.provider} · {agent.model}
                            {agent.instructions && ` · ${agent.instructions.split('\n')[0]}`}
                          </span>
                        </span>
                      </button>
                      <div className="flex items-center gap-0.5 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                        <button
                          onClick={() => openEdit(agent)}
                          className="inline-flex size-11 items-center justify-center md:size-7 text-muted-foreground hover:text-foreground hover:bg-row-hover rounded-md transition-colors"
                          title={intl.formatMessage({ id: 'common.edit', defaultMessage: 'Edit' })}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => void handleDelete(agent)}
                          className="inline-flex size-11 items-center justify-center md:size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                          title={intl.formatMessage({ id: 'common.delete', defaultMessage: 'Delete' })}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <div className="pl-10 pr-3 pb-2">
                        {liveBindings.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground/50 italic py-2">
                            <FormattedMessage id="channel.binding.none" defaultMessage="No active sessions." />
                          </p>
                        ) : (
                          <div className="space-y-1">
                            {liveBindings.map((b) => (
                              <BindingRow
                                key={b.id}
                                binding={b}
                                resetting={resettingBinding === b.id}
                                onReset={() => void handleBindingReset(b)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </ChannelDialog>

      {/* Create / Edit form dialog */}
      <ChannelDialog open={formOpen} onClose={handleFormClose} className="max-h-[85vh] max-w-lg overflow-hidden flex flex-col">
        <DialogHeader className="px-1 pt-1 pb-4 flex flex-row items-center justify-between shrink-0">
          <DialogTitle>
            {editing
              ? <FormattedMessage id="channel.form.editTitle" defaultMessage="Edit Agent" />
              : <FormattedMessage id="channel.form.newTitle" defaultMessage="New Agent" />}
          </DialogTitle>
          <Button aria-label="Close" variant="ghost" size="icon" className="size-11 md:size-7 rounded-md text-muted-foreground hover:text-foreground" onClick={handleFormClose}>
            <XIcon className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto -mx-6 px-6 code-scrollbar">
          <div className="space-y-5 pb-2">
            {/* Name */}
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}><FormattedMessage id="channel.form.name" defaultMessage="Name" /></label>
              <FormInput
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={intl.formatMessage({ id: 'channel.form.namePlaceholder', defaultMessage: 'e.g. architect' })}
              />
            </div>

            {/* Instructions */}
            <div className="space-y-1.5">
              <label className={FIELD_LABEL}><FormattedMessage id="channel.form.instructions" defaultMessage="Instructions" /></label>
              <Textarea
                value={form.instructions}
                onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                placeholder={intl.formatMessage({ id: 'channel.form.instructionsPlaceholder', defaultMessage: "Injected into the agent's system prompt at startup. Describe its role, knowledge, tone, do's and don'ts." })}
                rows={4}
                className={cn(FIELD_SURFACE, 'min-h-24 resize-y')}
              />
            </div>

            {/* Runtime: what the agent runs on and how freely */}
            <div className="rounded-lg border border-border/50 dark:border-border/35 divide-y divide-border/40 dark:divide-border/35">
              <RuntimeRow
                label={<FormattedMessage id="channel.form.adapter" defaultMessage="Adapter" />}
                hint={editing ? <FormattedMessage id="channel.form.adapterLocked" defaultMessage="Can't be changed after creation" /> : undefined}
              >
                {editing ? (
                  <span className="block truncate text-right text-sm text-muted-foreground">
                    {providers.find((p) => p.id === form.provider)?.label ?? form.provider}
                  </span>
                ) : (
                  <Select value={form.provider} onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}>
                    <SelectTrigger size="sm" className={RUNTIME_TRIGGER}>
                      <SelectValue placeholder={intl.formatMessage({ id: 'channel.form.selectAdapter', defaultMessage: 'Select adapter' })} />
                    </SelectTrigger>
                    <SelectContent align="end" position="popper" sideOffset={6}>
                      {providers.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </RuntimeRow>

              <RuntimeRow label={<FormattedMessage id="channel.form.model" defaultMessage="Model" />}>
                {mobile && availableModels.length > 0 ? (
                  <select aria-label={intl.formatMessage({ id: 'channel.form.model', defaultMessage: 'Model' })}
                    className="h-11 w-full rounded-lg border border-border/50 bg-background px-2 text-base"
                    value={model || form.model} onChange={(event) => {
                      const value = event.target.value
                      setModel(value)
                      setForm((f) => ({ ...f, model: value }))
                    }}>
                    {!availableModels.some((item) => item.id === (model || form.model)) && <option value={model || form.model}>{model || form.model || intl.formatMessage({ id: 'channel.form.selectModel', defaultMessage: 'Select model' })}</option>}
                    {availableModels.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                ) : availableModels.length > 0 ? (
                  <ModelSelector>
                    <ModelSelectorTrigger asChild>
                      <button type="button" className={cn(RUNTIME_TRIGGER, 'flex h-8 items-center justify-between gap-2 rounded-lg border px-3 text-sm outline-none transition-colors hover:bg-row-hover focus-visible:border-tint/40')}>
                        <span className="flex min-w-0 items-center gap-2">
                          {selectedModel && <ModelSelectorLogo provider={selectedModel.provider} className="size-3.5 shrink-0" />}
                          <span className={cn('truncate', !selectedModel && 'text-muted-foreground')}>
                            {selectedModel?.label ?? intl.formatMessage({ id: 'channel.form.selectModel', defaultMessage: 'Select model' })}
                          </span>
                        </span>
                        <ChevronDown className="size-4 shrink-0 opacity-50" />
                      </button>
                    </ModelSelectorTrigger>
                    <ModelSelectorContent>
                      <ModelSelectorInput placeholder={intl.formatMessage({ id: 'channel.form.searchModels', defaultMessage: 'Search models...' })} />
                      <ModelSelectorList>
                        {Object.entries(
                          availableModels.reduce<Record<string, typeof availableModels>>((groups, item) => {
                            (groups[item.group] ??= []).push(item)
                            return groups
                          }, {})
                        ).map(([group, items]) => (
                          <ModelSelectorGroup key={group} heading={group}>
                            {items.map((item) => (
                              <ModelSelectorItem key={item.id} value={`${item.label} ${item.id}`} onSelect={() => { setModel(item.id); setForm((f) => ({ ...f, model: item.id })) }}>
                                <ModelSelectorLogo provider={item.provider} />
                                <ModelSelectorName>{item.label}</ModelSelectorName>
                                {model === item.id && <ModelSelectorShortcut><FormattedMessage id="channel.form.current" defaultMessage="current" /></ModelSelectorShortcut>}
                              </ModelSelectorItem>
                            ))}
                          </ModelSelectorGroup>
                        ))}
                      </ModelSelectorList>
                    </ModelSelectorContent>
                  </ModelSelector>
                ) : (
                  <FormInput
                    value={form.model}
                    onChange={(e) => { setForm((f) => ({ ...f, model: e.target.value })); setModel(e.target.value) }}
                    placeholder={form.provider
                      ? intl.formatMessage({ id: 'channel.form.modelPlaceholder', defaultMessage: 'e.g. claude-sonnet-4-6' })
                      : intl.formatMessage({ id: 'channel.form.modelPlaceholderNoAdapter', defaultMessage: 'Select an adapter first' })}
                    className="h-8"
                  />
                )}
              </RuntimeRow>

              {thinkingEffortOptions.length > 0 && (
                <RuntimeRow
                  label={<FormattedMessage id="channel.form.effort" defaultMessage="Effort" />}
                  hint={<FormattedMessage id="channel.form.effortHint" defaultMessage="How much the model reasons before it acts" />}
                >
                  <Select
                    value={form.thinkingLevel || EFFORT_DEFAULT}
                    onValueChange={(v) => setForm((f) => ({ ...f, thinkingLevel: v === EFFORT_DEFAULT ? '' : v }))}
                  >
                    <SelectTrigger size="sm" className={RUNTIME_TRIGGER}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end" position="popper" sideOffset={6}>
                      <SelectItem value={EFFORT_DEFAULT}>
                        <FormattedMessage id="channel.form.effortDefault" defaultMessage="Default" />
                      </SelectItem>
                      {thinkingEffortOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </RuntimeRow>
              )}

              <RuntimeRow
                label={<FormattedMessage id="channel.form.permissionMode" defaultMessage="Permission Mode" />}
                hint={selectedPermission?.description
                  ?? <FormattedMessage id="channel.form.permissionHint" defaultMessage="Controls how this provider handles edits, commands, and network access." />}
              >
                <Select
                  value={permissionValue}
                  onValueChange={(v) => setForm((f) => ({ ...f, permissionMode: v }))}
                  disabled={permissionOptions.length === 0}
                >
                  <SelectTrigger size="sm" className={RUNTIME_TRIGGER}>
                    <SelectValue>
                      {selectedPermission?.label
                        ?? intl.formatMessage({ id: 'channel.form.selectPermissionMode', defaultMessage: 'Select mode' })}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end" position="popper" sideOffset={6} className="max-w-80">
                    {permissionOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <span className="flex flex-col items-start gap-0.5 whitespace-normal">
                          <span className="text-sm">{opt.label}</span>
                          {opt.description && (
                            <span className="text-xs text-muted-foreground">{opt.description}</span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </RuntimeRow>
            </div>

            {/* Environment Variables */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className={FIELD_LABEL}><FormattedMessage id="channel.form.envVars" defaultMessage="Environment Variables" /></label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setForm((f) => ({ ...f, env: [...f.env, { key: '', value: '', enabled: true }] }))}
                  className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <FormattedMessage id="channel.form.addVariable" defaultMessage="Add variable" />
                </Button>
              </div>
              {form.env.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/50 dark:border-border/35 px-3 py-2.5 text-xs text-muted-foreground">
                  <FormattedMessage id="channel.form.noEnvVars" defaultMessage="No variables. Add one to override the runtime env for this agent." />
                </p>
              ) : (
                <div className="space-y-2">
                  {form.env.map((entry, idx) => {
                    const inputCn = cn('h-8 flex-1 font-mono text-xs', !entry.enabled && 'opacity-60')
                    return (
                      <div key={envKeys.keys[idx]} className="flex items-center gap-2">
                        <FormInput
                          value={entry.key}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            env: f.env.map((x, i) => i === idx ? { ...x, key: e.target.value } : x),
                          }))}
                          placeholder={intl.formatMessage({ id: 'channel.form.envKeyPlaceholder', defaultMessage: 'KEY' })}
                          spellCheck={false}
                          className={inputCn}
                        />
                        <FormInput
                          value={entry.value}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            env: f.env.map((x, i) => i === idx ? { ...x, value: e.target.value } : x),
                          }))}
                          placeholder={intl.formatMessage({ id: 'channel.form.envValuePlaceholder', defaultMessage: 'value' })}
                          spellCheck={false}
                          className={inputCn}
                        />
                        <Switch
                          checked={entry.enabled}
                          onCheckedChange={(v) => setForm((f) => ({
                            ...f,
                            env: f.env.map((x, i) => i === idx ? { ...x, enabled: v } : x),
                          }))}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            envKeys.remove(idx)
                            setForm((f) => ({ ...f, env: f.env.filter((_, i) => i !== idx) }))
                          }}
                          className="p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors shrink-0"
                          title={intl.formatMessage({ id: 'common.remove', defaultMessage: 'Remove' })}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 mt-px shrink-0" />
                <span><FormattedMessage id="channel.form.envHint" defaultMessage="Env is read on session start. Toggle changes only apply after you Reset this agent." /></span>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={handleFormClose} className="h-8"><FormattedMessage id="common.cancel" defaultMessage="Cancel" /></Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleSave()}
            disabled={isSubmitDisabled}
            className="h-8"
          >
            {saving
              ? <FormattedMessage id="channel.form.saving" defaultMessage="Saving..." />
              : editing
                ? <FormattedMessage id="channel.form.saveChanges" defaultMessage="Save Changes" />
                : <FormattedMessage id="common.create" defaultMessage="Create" />}
          </Button>
        </DialogFooter>
      </ChannelDialog>
    </>
  )
}
