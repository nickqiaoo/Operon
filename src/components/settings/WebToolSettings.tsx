import { useRef, useState } from 'react'
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react'
import { defineMessages, useIntl } from 'react-intl'
import { fetchProviders, searchProviders, type KeyedProvider, type WebToolSelection, type WebToolSettings as Settings } from '@shared/web-tools'
import { useSaveWebToolSettings, useWebToolKey, useWebToolSettings } from '@/lib/web-tool-queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsRow, SettingsSection } from './SettingsSection'

const names = { deepseek: 'DeepSeek', tavily: 'Tavily', firecrawl: 'Firecrawl' }
const choices = { search: searchProviders, fetch: fetchProviders }
const messages = defineMessages({
  title: { id: 'settings.webTools.title', defaultMessage: 'Web tools' },
  hint: { id: 'settings.webTools.hint', defaultMessage: 'Provider changes apply to new sessions.' },
  search: { id: 'settings.webTools.search', defaultMessage: 'Web search' },
  fetch: { id: 'settings.webTools.fetch', defaultMessage: 'Read a web page' },
  direct: { id: 'settings.webTools.direct', defaultMessage: 'Direct HTTP' },
  off: { id: 'settings.webTools.off', defaultMessage: 'Off' },
  edit: { id: 'settings.webTools.edit', defaultMessage: 'Change {provider} API key' },
  key: { id: 'settings.webTools.key', defaultMessage: '{provider} API key' },
  showKey: { id: 'settings.webTools.showKey', defaultMessage: 'Show API key' },
  hideKey: { id: 'settings.webTools.hideKey', defaultMessage: 'Hide API key' },
  keyLoadError: { id: 'settings.webTools.keyLoadError', defaultMessage: 'Could not load the saved key. Reopen to retry or enter a replacement.' },
  loadError: { id: 'settings.webTools.loadError', defaultMessage: 'Could not load web tool settings.' },
  loading: { id: 'common.loading', defaultMessage: 'Loading…' },
  retry: { id: 'common.retry', defaultMessage: 'Retry' },
  saveFailed: { id: 'common.saveFailed', defaultMessage: 'Failed to save' },
  cancel: { id: 'common.cancel', defaultMessage: 'Cancel' },
  save: { id: 'common.save', defaultMessage: 'Save' },
})
type Action = keyof WebToolSelection
type Editor = { action: Action; provider: KeyedProvider; loadSaved?: boolean }

const keyed = (provider: string): provider is KeyedProvider => provider !== 'off' && provider !== 'direct'

export function WebToolSettings() {
  const { formatMessage: t } = useIntl()
  const query = useWebToolSettings()
  return (
    <SettingsSection title={t(messages.title)} description={t(messages.hint)}>
      {query.data ? <ProviderRows saved={query.data} /> : query.isError ? (
        <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
          {t(messages.loadError)}
          <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => query.refetch()}>{t(messages.retry)}</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t(messages.loading)}
        </div>
      )}
    </SettingsSection>
  )
}

function ProviderRows({ saved }: { saved: Settings }) {
  const { formatMessage: t } = useIntl()
  const [editor, setEditor] = useState<Editor | null>(null)
  // null until the user types: the field shows the saved key (once it loads) until then.
  const [typed, setTyped] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const savedKey = useWebToolKey(editor?.provider, !!editor?.loadSaved)
  const key = typed ?? (editor?.loadSaved ? savedKey.data?.key ?? '' : '')
  const triggers = useRef<Partial<Record<Action, HTMLButtonElement | null>>>({})
  const openingEditor = useRef(false)
  const save = useSaveWebToolSettings()

  function edit(next: Editor | null) {
    save.reset()
    setShowKey(false)
    setTyped(null)
    setEditor(next)
  }

  function select(action: Action, value: string) {
    const provider = choices[action].find(id => id === value)
    if (!provider) return
    if (keyed(provider) && !saved.configured.includes(provider)) {
      openingEditor.current = true
      edit({ action, provider })
      return
    }
    edit(null)
    save.mutate({ search: saved.search, fetch: saved.fetch, [action]: provider, keys: {} })
  }

  return (
    <div>
      {(['search', 'fetch'] as const).map(action => {
        const editing = editor?.action === action ? editor : null
        const current = editing?.provider ?? saved[action]
        const keyLabel = keyed(current) ? t(messages.edit, { provider: names[current] }) : ''
        const visibilityLabel = t(showKey ? messages.hideKey : messages.showKey)
        return (
          <Popover key={action} open={!!editing} onOpenChange={open => { if (!open && !save.isPending) edit(null) }}>
            <SettingsRow
              title={t(messages[action])}
              control={
                <PopoverAnchor asChild>
                  <div className="flex items-center gap-1">
                    {keyed(current) && !editing && (
                      <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label={keyLabel} title={keyLabel}
                        disabled={save.isPending} onClick={() => edit({ action, provider: current, loadSaved: true })}>
                        <KeyRound className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Select value={current} disabled={save.isPending} onValueChange={value => select(action, value)}>
                      <SelectTrigger ref={node => { triggers.current[action] = node }} size="sm" className="w-36" aria-label={t(messages[action])}><SelectValue /></SelectTrigger>
                      <SelectContent onCloseAutoFocus={event => {
                        if (openingEditor.current) {
                          event.preventDefault()
                          openingEditor.current = false
                        }
                      }}>{choices[action].map(id => (
                        <SelectItem key={id} value={id}>{keyed(id) ? names[id] : t(messages[id])}</SelectItem>
                      ))}</SelectContent>
                    </Select>
                  </div>
                </PopoverAnchor>
              }
            />
            {editing && (
              <PopoverContent align="end" sideOffset={6} collisionPadding={12} className="w-72 max-w-[calc(100vw-24px)]"
                aria-label={t(messages.key, { provider: names[editing.provider] })}
                onCloseAutoFocus={event => {
                  event.preventDefault()
                  triggers.current[action]?.focus()
                }}>
                <form className="space-y-3" onSubmit={event => {
                  event.preventDefault()
                  if (key.trim() && !save.isPending) {
                    save.mutate({ search: saved.search, fetch: saved.fetch, [action]: editing.provider, keys: { [editing.provider]: key.trim() } }, {
                      onSuccess: () => edit(null),
                    })
                  }
                }}>
                  <div className="grid gap-2">
                    <label htmlFor={`web-tool-key-${action}`} className="text-sm font-medium">
                      {t(messages.key, { provider: names[editing.provider] })}
                    </label>
                    <div className="relative">
                      <Input id={`web-tool-key-${action}`} autoFocus type={showKey ? 'text' : 'password'} className="pr-10"
                        autoComplete="new-password" spellCheck={false} autoCapitalize="none" value={key}
                        readOnly={editing.loadSaved && savedKey.isPending} disabled={save.isPending} aria-busy={editing.loadSaved && savedKey.isPending}
                        onChange={event => setTyped(event.target.value)} />
                      <Button type="button" variant="ghost" size="icon-sm" className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                        aria-label={visibilityLabel} title={visibilityLabel} onClick={() => setShowKey(visible => !visible)}>
                        {showKey ? <EyeOff /> : <Eye />}
                      </Button>
                    </div>
                  </div>
                  {editing.loadSaved && savedKey.isError && <div role="alert" className="flex items-center gap-2 text-xs text-destructive">{t(messages.keyLoadError)}</div>}
                  {save.isError && <div role="alert" className="flex items-center gap-2 text-xs text-destructive">{t(messages.saveFailed)}</div>}
                  <div className="flex items-center justify-end gap-1">
                    <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" disabled={save.isPending} onClick={() => edit(null)}>{t(messages.cancel)}</Button>
                    <Button type="submit" size="sm" variant="secondary" className="h-8 gap-1.5" disabled={!key.trim() || save.isPending}>
                      {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {t(messages.save)}
                    </Button>
                  </div>
                </form>
              </PopoverContent>
            )}
          </Popover>
        )
      })}
      {!editor && save.isError && <div role="alert" className="flex items-center gap-2 pt-2 text-xs text-destructive">{t(messages.saveFailed)}</div>}
    </div>
  )
}
