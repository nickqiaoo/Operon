import { useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { Plus, Pencil, Trash2, Bot, XIcon, X, Info, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
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
import { cn } from '@/lib/utils'
import { scopeLabel } from './channel-i18n'
import { countLive, BindingCountBadge, BindingRow } from './binding-ui'
import type { Agent, AgentBinding, AgentEnvVar } from '@/types/channel'

interface AgentManageDialogProps {
  open: boolean
  onClose: () => void
  providers: { id: string; label: string }[]
}

interface AgentFormState {
  name: string
  provider: string
  model: string
  instructions: string
  permissionMode: string
  env: AgentEnvVar[]
}

const EMPTY_FORM: AgentFormState = {
  name: '', provider: '', model: '', instructions: '', permissionMode: '', env: [],
}

const CleanInput = (props: React.ComponentProps<typeof Input>) => (
  <Input
    {...props}
    className={`bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background focus:border-tint/20 shadow-none transition-all ${props.className ?? ''}`}
  />
)


export function AgentManageDialog({ open, onClose, providers }: AgentManageDialogProps) {
  const intl = useIntl()
  const agents = useChannelStore((s) => s.agents)
  const createAgent = useChannelStore((s) => s.createAgent)
  const updateAgent = useChannelStore((s) => s.updateAgent)
  const deleteAgent = useChannelStore((s) => s.deleteAgent)
  const [editing, setEditing] = useState<Agent | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<AgentFormState>(EMPTY_FORM)
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
  const { model, setModel, availableModels, selectedModel, modeOptions, currentMode } = modelManagement

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
      const env = form.env
        .map((e) => ({ key: e.key.trim(), value: e.value, enabled: e.enabled }))
        .filter((e) => e.key.length > 0)
      if (editing) {
        // Server rejects any update payload containing `provider` — provider
        // is locked at create time to keep native SDK session state intact.
        await updateAgent(editing.id, {
          name: form.name, model: modelId,
          instructions: form.instructions, permissionMode, env,
        })
      } else {
        await createAgent({
          name: form.name, provider: form.provider, model: modelId,
          instructions: form.instructions, permissionMode, env,
        })
      }
      setFormOpen(false)
      setEditing(null)
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
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
        <DialogContent
          className="max-h-[75vh] max-w-md overflow-hidden flex flex-col"
          showCloseButton={false}
        >
          <DialogHeader className="px-1 pt-1 pb-2 flex flex-row items-center justify-between shrink-0">
            <div>
              <DialogTitle className="text-lg font-semibold tracking-tight">
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
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/50 transition-colors" onClick={onClose}>
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
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedAgentId(expanded ? null : agent.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setExpandedAgentId(expanded ? null : agent.id)
                          }
                        }}
                        className="flex items-center gap-3 hover:bg-muted/40 rounded-lg px-3 py-2.5 transition-colors group cursor-pointer"
                      >
                        <ChevronRight
                          className={cn(
                            'h-3.5 w-3.5 text-muted-foreground/50 transition-transform shrink-0',
                            expanded && 'rotate-90',
                          )}
                        />
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-tint/15 shrink-0">
                          <Bot className="w-4 h-4 text-tint" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-medium text-foreground truncate">{agent.name}</div>
                            <BindingCountBadge count={liveCount} total={liveBindings.length} />
                          </div>
                          <div className="text-xs text-muted-foreground/60 truncate">
                            {agent.provider} · {agent.model}
                            {agent.instructions && ` · ${agent.instructions.split('\n')[0]}`}
                          </div>
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); openEdit(agent) }}
                            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
                            title={intl.formatMessage({ id: 'common.edit', defaultMessage: 'Edit' })}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); void handleDelete(agent) }}
                            className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
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
        </DialogContent>
      </Dialog>

      {/* Create / Edit form dialog */}
      <Dialog open={formOpen} onOpenChange={(v) => { if (!v) handleFormClose() }}>
        <DialogContent
          className="max-h-[85vh] max-w-lg overflow-hidden flex flex-col"
          showCloseButton={false}
        >
          <DialogHeader className="px-1 pt-1 pb-4 flex flex-row items-center justify-between shrink-0">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              {editing
                ? <FormattedMessage id="channel.form.editTitle" defaultMessage="Edit Agent" />
                : <FormattedMessage id="channel.form.newTitle" defaultMessage="New Agent" />}
            </DialogTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/50 transition-colors" onClick={handleFormClose}>
              <XIcon className="h-4 w-4" />
            </Button>
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto -mx-6 px-6 code-scrollbar">
            <div className="space-y-5 pb-2">
              {/* Name */}
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1"><FormattedMessage id="channel.form.name" defaultMessage="Name" /></label>
                <CleanInput
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={intl.formatMessage({ id: 'channel.form.namePlaceholder', defaultMessage: 'e.g. architect' })}
                />
              </div>

              {/* Provider */}
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1"><FormattedMessage id="channel.form.adapter" defaultMessage="Adapter" /></label>
                <Select value={form.provider} onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}>
                  <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors">
                    <SelectValue placeholder={intl.formatMessage({ id: 'channel.form.selectAdapter', defaultMessage: 'Select adapter' })} />
                  </SelectTrigger>
                  <SelectContent align="start" position="popper" sideOffset={6} className="z-[80]">
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Model */}
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1"><FormattedMessage id="channel.form.model" defaultMessage="Model" /></label>
                {availableModels.length > 0 ? (
                  <ModelSelector>
                    <ModelSelectorTrigger asChild>
                      <Button variant="outline" className="w-full justify-between text-muted-foreground bg-muted/30 border-transparent hover:bg-muted/50 shadow-none font-normal h-10 px-3">
                        <span className="flex items-center gap-2">
                          <ModelSelectorLogo provider={selectedModel?.provider ?? ""} className="size-4" />
                          <span className="truncate">{selectedModel?.label ?? intl.formatMessage({ id: 'channel.form.selectModel', defaultMessage: 'Select model' })}</span>
                        </span>
                        <span className="text-xs opacity-50"><FormattedMessage id="channel.form.change" defaultMessage="Change" /></span>
                      </Button>
                    </ModelSelectorTrigger>
                    <ModelSelectorContent className="z-[80]">
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
                  <CleanInput
                    value={form.model}
                    onChange={(e) => { setForm((f) => ({ ...f, model: e.target.value })); setModel(e.target.value) }}
                    placeholder={form.provider
                      ? intl.formatMessage({ id: 'channel.form.modelPlaceholder', defaultMessage: 'e.g. claude-sonnet-4-6' })
                      : intl.formatMessage({ id: 'channel.form.modelPlaceholderNoAdapter', defaultMessage: 'Select an adapter first' })}
                  />
                )}
              </div>

              {/* Instructions */}
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1"><FormattedMessage id="channel.form.instructions" defaultMessage="Instructions" /></label>
                <Textarea
                  value={form.instructions}
                  onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                  placeholder={intl.formatMessage({ id: 'channel.form.instructionsPlaceholder', defaultMessage: "Injected into the agent's system prompt at startup. Describe its role, knowledge, tone, do's and don'ts." })}
                  rows={5}
                  className="bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background focus-visible:border-tint/20 focus-visible:ring-0 shadow-none transition-all resize-y"
                />
              </div>

              {/* Permission Mode */}
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1"><FormattedMessage id="channel.form.permissionMode" defaultMessage="Permission Mode" /></label>
                <Select
                  value={form.permissionMode || currentMode || modeOptions[0]?.value || ''}
                  onValueChange={(v) => setForm((f) => ({ ...f, permissionMode: v }))}
                  disabled={permissionOptions.length === 0}
                >
                  <SelectTrigger className="w-full bg-muted/30 border-transparent hover:bg-muted/50 focus:bg-background shadow-none transition-colors">
                    <SelectValue>
                      {permissionOptions.find((o) => o.value === (form.permissionMode || currentMode || modeOptions[0]?.value))?.label
                        ?? intl.formatMessage({ id: 'channel.form.selectPermissionMode', defaultMessage: 'Select mode' })}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start" position="popper" sideOffset={6} className="z-[80]">
                    {permissionOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm">{opt.label}</span>
                          {opt.description && (
                            <span className="text-[11px] text-muted-foreground/70">{opt.description}</span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground/60 ml-1">
                  <FormattedMessage id="channel.form.permissionHint" defaultMessage="Controls how this provider handles edits, commands, and network access." />
                </p>
              </div>

              {/* Environment Variables */}
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70 ml-1"><FormattedMessage id="channel.form.envVars" defaultMessage="Environment Variables" /></label>
                <div className="space-y-2">
                  {form.env.length === 0 && (
                    <p className="text-[11px] text-muted-foreground/60 italic ml-1"><FormattedMessage id="channel.form.noEnvVars" defaultMessage="No variables. Add one to override the runtime env for this agent." /></p>
                  )}
                  {form.env.map((entry, idx) => {
                    const dimmed = !entry.enabled
                    const inputCn = cn(
                      'h-8 font-mono text-xs bg-background border border-border/50 shadow-none',
                      'hover:border-border focus:border-tint/40 focus-visible:ring-0 focus-visible:ring-offset-0',
                      dimmed && 'opacity-60',
                    )
                    return (
                      <div key={idx} className="flex items-center gap-2">
                        <Input
                          value={entry.key}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            env: f.env.map((x, i) => i === idx ? { ...x, key: e.target.value } : x),
                          }))}
                          placeholder={intl.formatMessage({ id: 'channel.form.envKeyPlaceholder', defaultMessage: 'KEY' })}
                          spellCheck={false}
                          className={cn(inputCn, 'flex-1')}
                        />
                        <Input
                          value={entry.value}
                          onChange={(e) => setForm((f) => ({
                            ...f,
                            env: f.env.map((x, i) => i === idx ? { ...x, value: e.target.value } : x),
                          }))}
                          placeholder={intl.formatMessage({ id: 'channel.form.envValuePlaceholder', defaultMessage: 'value' })}
                          spellCheck={false}
                          className={cn(inputCn, 'flex-1')}
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
                          onClick={() => setForm((f) => ({ ...f, env: f.env.filter((_, i) => i !== idx) }))}
                          className="p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors shrink-0"
                          title={intl.formatMessage({ id: 'common.remove', defaultMessage: 'Remove' })}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
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
                <div className="flex items-start gap-1.5 mt-2 text-[10px] text-muted-foreground/60 ml-1">
                  <Info className="h-3 w-3 mt-0.5 shrink-0" />
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
        </DialogContent>
      </Dialog>
    </>
  )
}
