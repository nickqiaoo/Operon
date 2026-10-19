import { useState, useEffect, useCallback } from "react"
import {
  api,
  type McpServerEntry,
  type McpStdioEntry,
  type McpHttpEntry,
  type McpSseEntry,
  type PluginMcpServerView,
} from "@/lib/api"
import { openPluginsPage } from "@/lib/open-settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Plus, Trash2, ChevronDown, ChevronUp, Save, Loader2, ChevronRight, ShieldCheck, Plug, Package } from "lucide-react"
import { SettingsSection } from "./SettingsSection"
import { FormattedMessage, useIntl } from "react-intl"

type McpType = 'stdio' | 'http' | 'sse'

interface McpServerForm {
  name: string
  type: McpType
  command: string
  args: string
  env: string
  url: string
  headers: string
}

function emptyForm(): McpServerForm {
  return { name: '', type: 'stdio', command: '', args: '', env: '', url: '', headers: '' }
}

function entryToForm(name: string, entry: McpServerEntry): McpServerForm {
  if (!entry.type || entry.type === 'stdio') {
    const e = entry as McpStdioEntry
    return {
      name,
      type: 'stdio',
      command: e.command,
      args: (e.args ?? []).join(' '),
      env: Object.entries(e.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      url: '',
      headers: '',
    }
  }
  const e = entry as McpHttpEntry | McpSseEntry
  return {
    name,
    type: entry.type as McpType,
    command: '',
    args: '',
    env: '',
    url: e.url,
    headers: Object.entries(e.headers ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  }
}

function formToEntry(form: McpServerForm): McpServerEntry {
  if (form.type === 'stdio') {
    const args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined
    const envLines = form.env.trim().split('\n').filter(Boolean)
    const env: Record<string, string> = {}
    for (const line of envLines) {
      const idx = line.indexOf('=')
      if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1)
    }
    return {
      type: 'stdio',
      command: form.command.trim(),
      ...(args ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }
  }
  const headerLines = form.headers.trim().split('\n').filter(Boolean)
  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const idx = line.indexOf('=')
    if (idx > 0) headers[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return {
    type: form.type,
    url: form.url.trim(),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  } as McpHttpEntry | McpSseEntry
}

function isFormValid(form: McpServerForm): boolean {
  if (!form.name.trim()) return false
  if (form.type === 'stdio') return Boolean(form.command.trim())
  return Boolean(form.url.trim())
}

interface ServerRowProps {
  name: string
  entry: McpServerEntry
  editLabel: string
  onEdit: () => void
  onDelete: () => void
}

function ServerRow({ name, entry, editLabel, onEdit, onDelete }: ServerRowProps) {
  const typeLabel = !entry.type || entry.type === 'stdio' ? 'stdio' : entry.type.toUpperCase()
  const detail = !entry.type || entry.type === 'stdio'
    ? (entry as McpStdioEntry).command
    : (entry as McpHttpEntry | McpSseEntry).url

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border/40 bg-background/40 hover:bg-row-hover transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{name}</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
            {typeLabel}
          </span>
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">{detail}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onEdit}>
          {editLabel}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

/**
 * One MCP server an enabled plugin contributes. Read-only here — it is switched on and off (and
 * signed in to) from the plugin's page, so the whole row opens that page.
 */
function PluginServerRow({ server }: { server: PluginMcpServerView }) {
  const intl = useIntl()
  const note = server.shadowed
    ? intl.formatMessage({
        id: "settings.mcp.plugin.shadowed",
        defaultMessage: "Not mounted — a server above has the same name",
      })
    : server.mode === "skip"
      ? intl.formatMessage(
          { id: "settings.mcp.plugin.skipped", defaultMessage: "Not mounted — {reason}" },
          { reason: server.reason ?? "" },
        )
      : null
  return (
    <button
      type="button"
      onClick={() => openPluginsPage(server.pluginId)}
      className="group flex w-full items-center gap-3 rounded-lg border border-border/40 bg-background/40 px-4 py-3 text-left transition-colors hover:bg-row-hover"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{server.name}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
            {server.transport}
          </span>
          {server.mode === "gateway" && server.gatewayReason === "oauth" && (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
              title={intl.formatMessage({
                id: "settings.mcp.plugin.gatewayHint",
                defaultMessage: "Agents reach it through Operon, which holds the sign-in — they never see the token.",
              })}
            >
              <ShieldCheck className="h-3 w-3" />
              <FormattedMessage id="settings.mcp.plugin.gateway" defaultMessage="Via Operon sign-in" />
            </span>
          )}
        </div>
        <div className={cn("mt-0.5 truncate text-xs", note ? "text-status-warn" : "text-muted-foreground")}>
          {note ?? (
            <FormattedMessage
              id="settings.mcp.plugin.via"
              defaultMessage="via {plugin}"
              values={{ plugin: server.pluginName }}
            />
          )}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
    </button>
  )
}

interface ServerFormPanelProps {
  initial: McpServerForm
  existingNames: string[]
  editingName?: string
  onSave: (form: McpServerForm) => void
  onCancel: () => void
}

function ServerFormPanel({ initial, existingNames, editingName, onSave, onCancel }: ServerFormPanelProps) {
  const intl = useIntl()
  const [form, setForm] = useState<McpServerForm>(initial)
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(initial.env || initial.headers || initial.args)
  )

  const set = (patch: Partial<McpServerForm>) => setForm(f => ({ ...f, ...patch }))

  const nameConflict = form.name.trim() !== editingName && existingNames.includes(form.name.trim())
  const valid = isFormValid(form) && !nameConflict

  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-4 space-y-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          <FormattedMessage id="settings.mcp.serverName.label" defaultMessage="Server name" />
        </label>
        <Input
          value={form.name}
          onChange={e => set({ name: e.target.value })}
          placeholder={intl.formatMessage({ id: "settings.mcp.serverName.placeholder", defaultMessage: "my-server" })}
          className={cn("h-8 text-sm", nameConflict && "border-destructive/60")}
        />
        {nameConflict && (
          <p className="text-xs text-destructive">
            <FormattedMessage id="settings.mcp.serverName.conflict" defaultMessage="Name already exists" />
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          <FormattedMessage id="settings.mcp.type.label" defaultMessage="Type" />
        </label>
        <div className="flex gap-1 p-1 bg-muted/30 rounded-lg border border-border/50 w-fit">
          {(['stdio', 'http', 'sse'] as McpType[]).map(t => (
            <button
              key={t}
              onClick={() => set({ type: t })}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                form.type === t
                  ? "bg-background text-foreground shadow-card"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t === 'stdio' ? 'stdio' : t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {form.type === 'stdio' ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              <FormattedMessage id="settings.mcp.command.label" defaultMessage="Command" />
            </label>
            <Input
              value={form.command}
              onChange={e => set({ command: e.target.value })}
              placeholder="npx"
              className="h-8 text-sm font-mono"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            <FormattedMessage id="settings.mcp.url.label" defaultMessage="URL" />
          </label>
          <Input
            value={form.url}
            onChange={e => set({ url: e.target.value })}
            placeholder={form.type === 'http' ? 'http://localhost:3000/mcp' : 'http://localhost:3000/sse'}
            className="h-8 text-sm font-mono"
          />
        </div>
      )}

      <button
        onClick={() => setShowAdvanced(v => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        <FormattedMessage id="settings.mcp.advanced" defaultMessage="Advanced" />
      </button>

      {showAdvanced && (
        <div className="space-y-3 pt-1">
          {form.type === 'stdio' && (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  <FormattedMessage id="settings.mcp.args.label" defaultMessage="Args (space-separated)" />
                </label>
                <Input
                  value={form.args}
                  onChange={e => set({ args: e.target.value })}
                  placeholder="-y @modelcontextprotocol/server-filesystem /path"
                  className="h-8 text-sm font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  <FormattedMessage id="settings.mcp.env.label" defaultMessage="Env (one KEY=VALUE per line)" />
                </label>
                <textarea
                  value={form.env}
                  onChange={e => set({ env: e.target.value })}
                  placeholder={"API_KEY=abc123\nDEBUG=true"}
                  rows={3}
                  className="w-full rounded-md border border-border/50 bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </>
          )}
          {(form.type === 'http' || form.type === 'sse') && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                <FormattedMessage id="settings.mcp.headers.label" defaultMessage="Headers (one KEY=VALUE per line)" />
              </label>
              <textarea
                value={form.headers}
                onChange={e => set({ headers: e.target.value })}
                placeholder={"Authorization=Bearer token\nX-Api-Key=key"}
                rows={3}
                className="w-full rounded-md border border-border/50 bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" className="h-7" onClick={onCancel}>
          <FormattedMessage id="settings.mcp.cancel" defaultMessage="Cancel" />
        </Button>
        <Button size="sm" variant="secondary" className="h-7" disabled={!valid} onClick={() => onSave(form)}>
          <FormattedMessage id="settings.mcp.save" defaultMessage="Save" />
        </Button>
      </div>
    </div>
  )
}

export function McpSettings() {
  const intl = useIntl()
  const [servers, setServers] = useState<Record<string, McpServerEntry>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [editing, setEditing] = useState<null | 'new' | string>(null)
  const [pluginServers, setPluginServers] = useState<PluginMcpServerView[]>([])

  useEffect(() => {
    api.mcpGetServers().then(res => {
      setServers(res.servers ?? {})
      setLoading(false)
    }).catch(() => setLoading(false))
    // Best-effort: the plugin group is informational, the page works without it.
    api.mcpGetPluginServers().then(res => setPluginServers(res.servers ?? [])).catch(() => {})
  }, [])

  const persist = useCallback(async (next: Record<string, McpServerEntry>) => {
    setSaving(true)
    try {
      const res = await api.mcpSaveServers(next)
      setServers(res.servers)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }, [])

  const handleSaveForm = useCallback((form: McpServerForm, originalName?: string) => {
    const next = { ...servers }
    if (originalName && originalName !== form.name.trim()) {
      delete next[originalName]
    }
    next[form.name.trim()] = formToEntry(form)
    setEditing(null)
    persist(next)
  }, [servers, persist])

  const handleDelete = useCallback((name: string) => {
    const next = { ...servers }
    delete next[name]
    persist(next)
  }, [servers, persist])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  const names = Object.keys(servers)
  const editLabel = intl.formatMessage({ id: "settings.mcp.edit", defaultMessage: "Edit" })

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Plug}
        title={<FormattedMessage id="settings.mcp.title" defaultMessage="MCP Servers" />}
        description={<FormattedMessage id="settings.mcp.desc" defaultMessage="Configure Model Context Protocol servers available to all providers." />}
        action={editing !== 'new' && (
          <Button
            data-testid="settings-mcp-add-server"
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setEditing('new')}
          >
            <Plus className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.mcp.addServer" defaultMessage="Add server" />
          </Button>
        )}
      >
        <div className="space-y-2">
          {names.length === 0 && editing !== 'new' && (
            <div className="rounded-xl border border-dashed border-border/40 py-6 text-center text-sm text-muted-foreground">
              <FormattedMessage id="settings.mcp.empty" defaultMessage="No MCP servers configured yet." />
            </div>
          )}

          {names.map(name => (
            editing === name ? (
              <ServerFormPanel
                key={name}
                initial={entryToForm(name, servers[name])}
                existingNames={names}
                editingName={name}
                onSave={form => handleSaveForm(form, name)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <ServerRow
                key={name}
                name={name}
                entry={servers[name]}
                editLabel={editLabel}
                onEdit={() => setEditing(name)}
                onDelete={() => handleDelete(name)}
              />
            )
          ))}

          {editing === 'new' && (
            <ServerFormPanel
              initial={emptyForm()}
              existingNames={names}
              onSave={form => handleSaveForm(form)}
              onCancel={() => setEditing(null)}
            />
          )}
        </div>

        {(saving || saved) && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {saving
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> <FormattedMessage id="settings.mcp.saving" defaultMessage="Saving…" /></>
              : <><Save className="h-3.5 w-3.5 text-status-ok" /> <FormattedMessage id="settings.mcp.saved" defaultMessage="Saved" /></>
            }
          </div>
        )}
      </SettingsSection>

      {pluginServers.length > 0 && (
        <SettingsSection
          icon={Package}
          title={<FormattedMessage id="settings.mcp.plugin.title" defaultMessage="From plugins" />}
          description={
            <FormattedMessage
              id="settings.mcp.plugin.desc"
              defaultMessage="Added to every agent by your enabled plugins. Turn them on or off on the Plugins page."
            />
          }
        >
          <div className="space-y-2">
            {pluginServers.map(server => (
              <PluginServerRow key={server.name} server={server} />
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  )
}
