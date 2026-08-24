import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { invalidateModelsCache } from '@/components/editor/hooks/useModelManagement'
import { Button } from '@/components/ui/button'
import { Check, Eye, EyeOff, Loader2, RefreshCw, AlertCircle, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FormattedMessage, useIntl } from 'react-intl'

// Local SVG imports — guaranteed to work in Electron renderer
import anthropicLogo from '@/assets/logos/claude.svg'
import openaiLogo from '@/assets/logos/openai.svg'
import googleLogo from '@/assets/logos/google.svg'
import deepseekLogo from '@/assets/logos/deepseek.svg'
import kimiLogo from '@/assets/logos/kimi.svg'
import glmLogo from '@/assets/logos/zhipuai.svg'
import minimaxLogo from '@/assets/logos/minimax.svg'
import grokLogo from '@/assets/logos/xai.svg'
import openrouterLogo from '@/assets/logos/openrouter.svg'
import ollamaLogo from '@/assets/logos/ollama.svg'

interface ProviderModel { id: string; name: string }

interface ProviderState {
  hasApiKey: boolean
  apiKey?: string
  baseUrl?: string
  enabled: boolean
  manualModels?: string[]
}

interface ProviderMeta {
  id: string
  label: string
  logo: string
  placeholder: string
  defaultBaseUrl: string
}

const PROVIDERS: ProviderMeta[] = [
  { id: 'anthropic', label: 'Anthropic', logo: anthropicLogo, placeholder: 'sk-ant-api03-…', defaultBaseUrl: 'https://api.anthropic.com' },
  { id: 'openai', label: 'OpenAI', logo: openaiLogo, placeholder: 'sk-…', defaultBaseUrl: 'https://api.openai.com' },
  { id: 'google', label: 'Google', logo: googleLogo, placeholder: 'AIzaSy…', defaultBaseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'deepseek', label: 'DeepSeek', logo: deepseekLogo, placeholder: 'sk-…', defaultBaseUrl: 'https://api.deepseek.com' },
  { id: 'kimi', label: 'Kimi', logo: kimiLogo, placeholder: 'sk-…', defaultBaseUrl: 'https://api.moonshot.cn' },
  { id: 'glm', label: 'GLM', logo: glmLogo, placeholder: 'API key…', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'minimax', label: 'MiniMax', logo: minimaxLogo, placeholder: 'API key…', defaultBaseUrl: 'https://api.minimax.chat/v1' },
  { id: 'grok', label: 'Grok', logo: grokLogo, placeholder: 'xai-…', defaultBaseUrl: 'https://api.x.ai' },
  { id: 'openrouter', label: 'OpenRouter', logo: openrouterLogo, placeholder: 'sk-or-…', defaultBaseUrl: 'https://openrouter.ai/api' },
  { id: 'ollama', label: 'Ollama', logo: ollamaLogo, placeholder: '(not required)', defaultBaseUrl: 'http://localhost:11434' },
]

const NO_KEY_PROVIDERS = new Set(['ollama'])

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------
function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none',
        checked ? 'bg-green-500' : 'bg-muted-foreground/30',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      )}
    >
      <span className={cn(
        'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200',
        checked ? 'translate-x-4' : 'translate-x-0'
      )} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Provider icon
// ---------------------------------------------------------------------------
function ProviderLogo({ src, size = 18 }: { src: string; size?: number }) {
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="dark:invert flex-shrink-0"
      style={{ width: size, height: size, objectFit: 'contain' }}
    />
  )
}

// ---------------------------------------------------------------------------
// Right panel
// ---------------------------------------------------------------------------
function ProviderPanel({ provider, saved, onSaved }: {
  provider: ProviderMeta
  saved: ProviderState | undefined
  onSaved: () => void
}) {
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? '')
  const [manualModels, setManualModels] = useState<string[]>(saved?.manualModels ?? [])
  const [newModelId, setNewModelId] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [saveErr, setSaveErr] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [models, setModels] = useState<ProviderModel[]>([])
  const [modelError, setModelError] = useState('')
  const intl = useIntl()

  const savedManualModels = saved?.manualModels ?? []

  useEffect(() => {
    setApiKey(saved?.apiKey ?? '')
    setBaseUrl(saved?.baseUrl ?? '')
    setManualModels(saved?.manualModels ?? [])
    setNewModelId('')
    setShowKey(false)
    setModels([])
    setModelError('')
  }, [provider.id, saved?.apiKey, saved?.baseUrl, saved?.manualModels])

  const noKeyRequired = NO_KEY_PROVIDERS.has(provider.id)
  const hasCredential = noKeyRequired || !!apiKey.trim()
  const isEnabled = saved?.enabled ?? false
  const manualModelsDirty =
    manualModels.length !== savedManualModels.length ||
    manualModels.some((m, i) => m !== savedManualModels[i])
  const isDirty =
    apiKey.trim() !== (saved?.apiKey ?? '') ||
    baseUrl.trim() !== (saved?.baseUrl ?? '') ||
    manualModelsDirty

  function addManualModel() {
    const id = newModelId.trim()
    if (!id || manualModels.includes(id)) { setNewModelId(''); return }
    setManualModels((prev) => [...prev, id])
    setNewModelId('')
  }

  function removeManualModel(id: string) {
    setManualModels((prev) => prev.filter((m) => m !== id))
  }

  async function handleSave() {
    setSaving(true); setSavedOk(false); setSaveErr(false)
    try {
      await api.providerConfigSave(provider.id, {
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        manualModels,
      })
      setSavedOk(true)
      onSaved()
      invalidateModelsCache()
      setTimeout(() => setSavedOk(false), 2000)
    } catch {
      setSaveErr(true)
      setTimeout(() => setSaveErr(false), 2000)
    } finally { setSaving(false) }
  }

  async function handleToggle(next: boolean) {
    if (toggling) return
    setToggling(true)
    try {
      await api.providerConfigSave(provider.id, { enabled: next })
      onSaved()
      invalidateModelsCache()
    } finally { setToggling(false) }
  }

  async function handleFetchModels() {
    setFetchingModels(true); setModelError(''); setModels([])
    const fallbackMsg = intl.formatMessage({ id: 'settings.providers.fetchFailed', defaultMessage: 'Failed to fetch models' })
    try {
      const res = await api.providerConfigFetchModels(provider.id, {
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl,
      })
      // The HTTP helper resolves on non-2xx too, returning { error } with no
      // models — so guard instead of trusting res.models to be an array.
      if (!res.models) {
        setModelError(res.error || fallbackMsg)
        return
      }
      setModels(res.models)
    } catch (e) {
      setModelError(e instanceof Error ? e.message : fallbackMsg)
    } finally { setFetchingModels(false) }
  }

  const inputCn = 'w-full px-3 py-2 text-sm font-mono bg-background/80 rounded-xl border border-border/60 focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/40'

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-muted/40 flex-shrink-0">
            <ProviderLogo src={provider.logo} size={22} />
          </div>
          <div>
            <div className="text-sm font-semibold flex items-center gap-2">
              {provider.label}
              {hasCredential && (
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-green-600 dark:text-green-400">
                  <Check className="h-3 w-3" /> <FormattedMessage id="settings.providers.configured" defaultMessage="Configured" />
                </span>
              )}
            </div>
          </div>
        </div>
        {/* Enable toggle */}
        <div className="flex items-center flex-shrink-0 sm:pt-0.5">
          <Toggle checked={isEnabled} onChange={handleToggle} disabled={toggling} />
        </div>
      </div>

      <div className="border-t border-border/60" />

      {/* ── API Key ── */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"><FormattedMessage id="settings.providers.apiKey" defaultMessage="API Key" /></div>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.placeholder}
            className={cn(inputCn, 'pr-9')}
            spellCheck={false}
          />
          {(apiKey.length > 0 || hasCredential) && (
            <button
              type="button"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {noKeyRequired
            ? <FormattedMessage id="settings.providers.apiKeyOptional" defaultMessage="API key is optional for this provider." />
            : hasCredential
              ? <FormattedMessage id="settings.providers.clickSaveToUpdate" defaultMessage="Click Save to update." />
              : <FormattedMessage id="settings.providers.apiKeyRequired" defaultMessage="Required to use this provider." />}
        </p>
      </div>

      {/* ── Base URL ── */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"><FormattedMessage id="settings.providers.baseUrl" defaultMessage="Base URL" /></div>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={provider.defaultBaseUrl}
          className={inputCn}
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          <FormattedMessage id="settings.providers.baseUrlHint" defaultMessage="Leave blank to use the default endpoint. Override for proxies or self-hosted deployments." />
        </p>
      </div>

      {/* ── Custom model IDs ── */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          <FormattedMessage id="settings.providers.customModels" defaultMessage="Custom Model IDs" />
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newModelId}
            onChange={(e) => setNewModelId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addManualModel() }
            }}
            placeholder={intl.formatMessage({ id: 'settings.providers.customModelsPlaceholder', defaultMessage: 'e.g. my-model-v1' })}
            className={cn(inputCn, 'flex-1')}
            spellCheck={false}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={addManualModel}
            disabled={!newModelId.trim()}
            className="h-9 gap-1.5 shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            <FormattedMessage id="common.add" defaultMessage="Add" />
          </Button>
        </div>
        {manualModels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {manualModels.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 pl-2.5 pr-1.5 py-1 text-xs font-mono"
              >
                <span className="truncate max-w-[220px]">{id}</span>
                <button
                  type="button"
                  onClick={() => removeManualModel(id)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={intl.formatMessage({ id: 'settings.providers.removeModel', defaultMessage: 'Remove model' })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="settings.providers.customModelsHint"
            defaultMessage="Add model IDs by hand when this provider's API can't list them. Saved IDs appear in the chat model picker."
          />
        </p>
      </div>

      {/* ── Actions ── */}
      <div className="flex flex-col gap-3 pt-1 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleFetchModels}
            disabled={fetchingModels || !hasCredential}
            className="h-8 gap-1.5"
          >
            {fetchingModels ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <FormattedMessage id="settings.providers.fetchModels" defaultMessage="Fetch Models" />
          </Button>
          {modelError && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {modelError}
            </span>
          )}
          {models.length > 0 && !modelError && (
            <span className="text-xs text-muted-foreground">
              <FormattedMessage id="settings.providers.modelsAvailable" defaultMessage="{count} models available" values={{ count: models.length }} />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 lg:justify-end">
          {savedOk && <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><Check className="h-3.5 w-3.5" /> <FormattedMessage id="common.saved" defaultMessage="Saved" /></span>}
          {saveErr && <span className="flex items-center gap-1 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> <FormattedMessage id="settings.providers.failed" defaultMessage="Failed" /></span>}
          <Button size="sm" variant="secondary" onClick={handleSave} disabled={saving || !isDirty} className="h-8 gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <FormattedMessage id="common.save" defaultMessage="Save" />
          </Button>
        </div>
      </div>

      {/* ── Model list ── */}
      {models.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"><FormattedMessage id="settings.providers.availableModels" defaultMessage="Available Models" /></div>
          <div className="rounded-xl bg-muted/20 border border-border/60 p-3 max-h-52 overflow-y-auto code-scrollbar">
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              {models.map((m) => (
                <div key={m.id} className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-muted-foreground/30 flex-shrink-0" />
                  <span className="text-xs text-foreground/70 font-mono truncate">{m.id}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Left column item
// ---------------------------------------------------------------------------
function ProviderItem({ provider, state, selected, onClick }: {
  provider: ProviderMeta
  state: ProviderState | undefined
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-all',
        selected
          ? 'bg-background text-foreground shadow-card ring-1 ring-border/40'
          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
      )}
    >
      <div className={cn(
        'flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0',
        selected ? 'bg-background/80' : 'bg-muted/40'
      )}>
        <ProviderLogo src={provider.logo} size={14} />
      </div>
      <span className="flex-1 text-sm font-medium">{provider.label}</span>
      <span className={cn(
        'h-1.5 w-1.5 rounded-full flex-shrink-0',
        state?.enabled ? 'bg-green-500' : state?.hasApiKey ? 'bg-amber-400' : 'bg-muted-foreground/20'
      )} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export function ProvidersTab() {
  const [selectedId, setSelectedId] = useState(PROVIDERS[0].id)
  const [configs, setConfigs] = useState<Record<string, ProviderState>>({})

  async function loadConfigs() {
    try {
      const res = await api.providerConfigGetAll()
      setConfigs(res.configs)
    } catch { /* ignore */ }
  }

  useEffect(() => { loadConfigs() }, [])

  const selectedProvider = PROVIDERS.find((p) => p.id === selectedId)!

  return (
    <div className="grid min-h-[520px] gap-4 lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-5">

      {/* Left column */}
      <div className="flex flex-col rounded-2xl border border-border/60 bg-muted/15 p-2">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pb-2">
          <FormattedMessage id="settings.providers.heading" defaultMessage="Providers" />
        </p>

        <div className="space-y-0.5">
          {PROVIDERS.map((p) => (
            <ProviderItem
              key={p.id}
              provider={p}
              state={configs[p.id]}
              selected={p.id === selectedId}
              onClick={() => setSelectedId(p.id)}
            />
          ))}
        </div>

        {/* Legend */}
        <div className="mt-4 pt-3 px-2 space-y-1.5 border-t border-border/60">
          {[
            { dot: 'bg-green-500', key: 'enabled', label: <FormattedMessage id="settings.providers.legendEnabled" defaultMessage="Enabled" /> },
            { dot: 'bg-amber-400', key: 'keySaved', label: <FormattedMessage id="settings.providers.legendKeySaved" defaultMessage="Key saved" /> },
            { dot: 'bg-muted-foreground/20', key: 'notConfigured', label: <FormattedMessage id="settings.providers.legendNotConfigured" defaultMessage="Not configured" /> },
          ].map(({ dot, key, label }) => (
            <div key={key} className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className={cn('h-1.5 w-1.5 rounded-full flex-shrink-0', dot)} />
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* Right column */}
      <div className="min-w-0 rounded-2xl border border-border/60 bg-background/80 p-4 sm:p-5">
        <ProviderPanel
          key={selectedId}
          provider={selectedProvider}
          saved={configs[selectedId]}
          onSaved={loadConfigs}
        />
      </div>
    </div>
  )
}
