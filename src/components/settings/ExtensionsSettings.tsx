import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { FormattedMessage, useIntl, type IntlShape } from "react-intl"
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Download,
  Loader2,
  PackageOpen,
  Play,
  Puzzle,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { ExtensionMarketplaceEntryDTO, ExtensionRepairOutcome, OperonExtensionDTO, OperonExtensionState } from "@/types/extension"
import { TeamsSettings } from "./TeamsSettings"

/** Product-owned settings views contributed by a known extension id. */
const CONFIGURE_VIEWS: Record<string, () => React.JSX.Element> = {
  peers: () => <TeamsSettings />,
}

function extensionName(intl: IntlShape, id: string, fallback: string): string {
  if (id === "peers") return intl.formatMessage({ id: "settings.extensions.peers.name", defaultMessage: "Teams" })
  return fallback
}

function extensionDescription(intl: IntlShape, id: string, fallback?: string): string | undefined {
  if (id === "peers") {
    return intl.formatMessage({
      id: "settings.extensions.peers.description",
      defaultMessage: "Let a conversation form a team and spawn teammates: independent sessions that work in parallel, message each other, and report back. Each teammate appears as its own conversation.",
    })
  }
  return fallback
}

/** Every listed entry runs on this build — the server leaves out the ones that do not — so this
 *  is the minimum version, not a warning. */
function extensionCompatibility(intl: IntlShape, entry: ExtensionMarketplaceEntryDTO): string {
  return intl.formatMessage(
    { id: "settings.extensions.requiresOperon", defaultMessage: "Requires Operon {version} or later" },
    { version: entry.minOperonVersion },
  )
}

export function ExtensionsSettings() {
  const intl = useIntl()
  const [items, setItems] = useState<OperonExtensionDTO[]>([])
  const [marketplace, setMarketplace] = useState<ExtensionMarketplaceEntryDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [marketError, setMarketError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [marketBusy, setMarketBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [installUrl, setInstallUrl] = useState("")
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [confirmLoad, setConfirmLoad] = useState<OperonExtensionDTO | null>(null)
  const [configuring, setConfiguring] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    setMarketError(null)
    const [installedResult, marketResult] = await Promise.all([
      api.extensionsList().catch((reason: unknown) => ({ extensions: [], error: reason instanceof Error ? reason.message : String(reason) })),
      api.extensionsMarketplace().catch((reason: unknown) => ({ generatedAt: "", extensions: [], error: reason instanceof Error ? reason.message : String(reason) })),
    ])
    if (installedResult.error) setError(installedResult.error)
    else setItems(installedResult.extensions ?? [])
    if (marketResult.error) setMarketError(marketResult.error)
    else setMarketplace(marketResult.extensions ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const run = useCallback(
    async (id: string, fn: () => Promise<{ ok?: true; error?: string }>) => {
      setBusy(id)
      setActionError(null)
      setNotice(null)
      try {
        const result = await fn()
        if (result.error) throw new Error(result.error)
        await reload()
      } catch (reason) {
        setActionError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(null)
      }
    },
    [reload],
  )

  const installFromMarketplace = useCallback(async (entry: ExtensionMarketplaceEntryDTO) => {
    setMarketBusy(entry.id)
    setActionError(null)
    setNotice(null)
    try {
      const result = await api.extensionsMarketplaceInstall(entry.id)
      if (result.error) throw new Error(result.error)
      setNotice(entry.status === "update"
        ? intl.formatMessage(
          { id: "settings.extensions.notice.updated", defaultMessage: "{name} {version} was downloaded. Reload it below to apply the update." },
          { name: extensionName(intl, entry.id, entry.name), version: entry.version },
        )
        : intl.formatMessage(
          { id: "settings.extensions.notice.installed", defaultMessage: "{name} was installed. Load it below when you are ready to enable it." },
          { name: extensionName(intl, entry.id, entry.name) },
        ))
      await reload()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setMarketBusy(null)
    }
  }, [intl, reload])

  const installManual = useCallback(
    async (input: { url?: string; zipBase64?: string }) => {
      setInstalling(true)
      setInstallError(null)
      setNotice(null)
      try {
        const result = await api.extensionsInstall(input)
        if (result.error) throw new Error(result.error)
        setInstallUrl("")
        setNotice(intl.formatMessage({
          id: "settings.extensions.notice.manualInstalled",
          defaultMessage: "Extension installed. Load it below when you are ready to enable it.",
        }))
        await reload()
      } catch (reason) {
        setInstallError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setInstalling(false)
      }
    },
    [intl, reload],
  )

  const onPickFile = useCallback((file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      const base64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result
      void installManual({ zipBase64: base64 })
    }
    reader.onerror = () => setInstallError(intl.formatMessage({ id: "settings.extensions.fileReadError", defaultMessage: "Could not read the file" }))
    reader.readAsDataURL(file)
  }, [installManual, intl])

  const requestLoad = (extension: OperonExtensionDTO) => {
    if (extension.state === "new") setConfirmLoad(extension)
    else void run(extension.id, () => api.extensionsLoad(extension.id))
  }

  const ConfigureView = configuring ? CONFIGURE_VIEWS[configuring] : undefined
  if (configuring && ConfigureView) {
    const extension = items.find((item) => item.id === configuring)
    return (
      <div className="space-y-6">
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            setConfiguring(null)
            void reload()
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.extensions.back" defaultMessage="Extensions" />
          <span className="text-muted-foreground/60">/</span>
          <span className="text-foreground">{extensionName(intl, configuring, extension?.name ?? configuring)}</span>
        </button>
        <ConfigureView />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4 px-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent-purple" />
            <div>
              <h3 className="text-sm font-semibold">
                <FormattedMessage id="settings.extensions.marketplaceTitle" defaultMessage="Marketplace" />
              </h3>
              <p className="text-xs text-muted-foreground">
                <FormattedMessage id="settings.extensions.marketplaceDesc" defaultMessage="Verified extensions published by Operon." />
              </p>
            </div>
          </div>
          <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1.5 text-xs" onClick={() => void reload()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <FormattedMessage id="settings.extensions.refresh" defaultMessage="Refresh" />
          </Button>
        </div>
        {actionError ? <InlineMessage tone="error" message={actionError} /> : null}
        {notice ? <InlineMessage tone="success" message={notice} /> : null}
        {marketError ? (
          <div className="rounded-xl border border-status-error/15 bg-status-error/5 p-4">
            <InlineMessage tone="error" message={marketError} />
          </div>
        ) : loading && marketplace.length === 0 ? (
          <LoadingBlock />
        ) : marketplace.length === 0 ? (
          <EmptyBlock message={<FormattedMessage id="settings.extensions.marketplaceEmpty" defaultMessage="No extensions are available right now." />} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {marketplace.map((entry) => (
              <MarketplaceCard key={entry.id} entry={entry} busy={marketBusy === entry.id} onInstall={() => void installFromMarketplace(entry)} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <PackageOpen className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">
              <FormattedMessage id="settings.extensions.installedTitle" defaultMessage="Installed" />
            </h3>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage id="settings.extensions.installedDesc" defaultMessage="Load, configure, update, or remove extensions on this device." />
            </p>
          </div>
        </div>
        {error ? (
          <div className="rounded-xl border border-status-error/15 bg-status-error/5 p-4"><InlineMessage tone="error" message={error} /></div>
        ) : loading && items.length === 0 ? (
          <LoadingBlock />
        ) : items.length === 0 ? (
          <EmptyBlock message={<FormattedMessage id="settings.extensions.empty" defaultMessage="No extensions installed yet. Choose one from the marketplace above." />} />
        ) : (
          <div className="divide-y divide-border/40 rounded-xl border border-border/40 bg-background/40">
            {items.map((extension) => (
              <ExtensionRow
                key={extension.id}
                ext={extension}
                busy={busy === extension.id}
                onLoad={() => requestLoad(extension)}
                onReload={() => void run(extension.id, () => api.extensionsReload(extension.id))}
                onUnload={() => void run(extension.id, () => api.extensionsUnload(extension.id))}
                onRemove={() => void run(extension.id, () => api.extensionsRemove(extension.id))}
                onConfigure={extension.id in CONFIGURE_VIEWS ? () => setConfiguring(extension.id) : undefined}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
        <div className="flex items-start gap-3">
          <Download className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h3 className="mb-1 text-sm font-semibold">
              <FormattedMessage id="settings.extensions.advancedTitle" defaultMessage="Advanced install" />
            </h3>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.extensions.installDesc"
                defaultMessage="Install a trusted zip manually or provide a release URL. Marketplace extensions are safer because their identity, version, size, and SHA-256 are verified."
              />
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={installUrl}
            onChange={(event) => setInstallUrl(event.target.value)}
            placeholder="https://example.com/releases/my-extension-1.0.0.zip"
            className="h-8 border-border/50 text-xs"
            onKeyDown={(event) => {
              if (event.key === "Enter" && installUrl.trim()) void installManual({ url: installUrl.trim() })
            }}
          />
          <Button size="sm" variant="secondary" className="h-8 shrink-0 gap-1.5" disabled={installing || !installUrl.trim()} onClick={() => void installManual({ url: installUrl.trim() })}>
            {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            <FormattedMessage id="settings.extensions.installUrl" defaultMessage="Install from URL" />
          </Button>
          <Button size="sm" variant="secondary" className="h-8 shrink-0 gap-1.5" disabled={installing} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            <FormattedMessage id="settings.extensions.installFile" defaultMessage="From file" />
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              onPickFile(event.target.files?.[0])
              event.target.value = ""
            }}
          />
        </div>
        {installError ? <InlineMessage tone="error" message={installError} /> : null}
      </section>

      <Dialog open={confirmLoad !== null} onOpenChange={(open) => !open && setConfirmLoad(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-status-warn" />
              <FormattedMessage
                id="settings.extensions.confirmTitle"
                defaultMessage="Load {name}?"
                values={{ name: confirmLoad ? extensionName(intl, confirmLoad.id, confirmLoad.name ?? confirmLoad.id) : "" }}
              />
            </DialogTitle>
            <DialogDescription>
              <FormattedMessage
                id="settings.extensions.confirmDesc"
                defaultMessage="An extension runs inside Operon with the same access as the app itself. Only load extensions you trust. Loading approves this exact build; an update requires approval again."
              />
            </DialogDescription>
          </DialogHeader>
          {confirmLoad?.description ? (
            <div className="rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
              {extensionDescription(intl, confirmLoad.id, confirmLoad.description)}
            </div>
          ) : null}
          <DialogFooter>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setConfirmLoad(null)}>
              {intl.formatMessage({ id: "settings.extensions.cancel", defaultMessage: "Cancel" })}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1.5"
              onClick={() => {
                const extension = confirmLoad
                setConfirmLoad(null)
                if (extension) void run(extension.id, () => api.extensionsLoad(extension.id))
              }}
            >
              <Play className="h-3.5 w-3.5" />
              {intl.formatMessage({ id: "settings.extensions.load", defaultMessage: "Load" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MarketplaceCard({ entry, busy, onInstall }: { entry: ExtensionMarketplaceEntryDTO; busy: boolean; onInstall: () => void }) {
  const intl = useIntl()
  const disabled = entry.status === "installed" || busy
  const action = entry.status === "update"
    ? intl.formatMessage({ id: "settings.extensions.action.update", defaultMessage: "Update" })
    : entry.status === "installed"
      ? intl.formatMessage({ id: "settings.extensions.action.installed", defaultMessage: "Installed" })
      : intl.formatMessage({ id: "settings.extensions.action.install", defaultMessage: "Install" })
  const name = extensionName(intl, entry.id, entry.name)
  const description = extensionDescription(intl, entry.id, entry.description)
  return (
    <article className="flex min-h-44 flex-col rounded-xl border border-border/40 bg-gradient-to-br from-background/90 to-muted/20 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-purple/10 text-accent-purple"><Puzzle className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">{name}</h4>
            <span className="text-[11px] text-muted-foreground">v{entry.version}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>{entry.publisher.name}</span>
            {entry.publisher.verified ? (
              <BadgeCheck
                className="h-3.5 w-3.5 text-status-info"
                aria-label={intl.formatMessage({ id: "settings.extensions.verifiedPublisher", defaultMessage: "Verified publisher" })}
              />
            ) : null}
          </div>
        </div>
      </div>
      <p className="mt-3 flex-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="min-w-0 text-[10px] text-muted-foreground">
          {extensionCompatibility(intl, entry)}
          {entry.installedVersion && entry.status === "update" ? (
            <div>
              {intl.formatMessage(
                { id: "settings.extensions.installedVersion", defaultMessage: "Installed: {version}" },
                { version: entry.installedVersion },
              )}
            </div>
          ) : null}
        </div>
        <Button size="sm" variant={entry.status === "update" ? "secondary" : "default"} className="h-8 min-w-20 gap-1.5" disabled={disabled} onClick={onInstall}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {action}
        </Button>
      </div>
    </article>
  )
}

const STATE_CLASS: Record<OperonExtensionState, string> = {
  loaded: "bg-status-ok/10 text-status-ok border-status-ok/15",
  approved: "bg-status-info/10 text-status-info border-status-info/15",
  new: "bg-muted text-muted-foreground border-border/40",
  changed: "bg-status-warn/10 text-status-warn border-status-warn/15",
  error: "bg-status-error/10 text-status-error border-status-error/15",
}

function extensionStateLabel(intl: IntlShape, state: OperonExtensionState): string {
  if (state === "loaded") return intl.formatMessage({ id: "settings.extensions.state.loaded", defaultMessage: "Loaded" })
  if (state === "approved") return intl.formatMessage({ id: "settings.extensions.state.approved", defaultMessage: "Approved" })
  if (state === "new") return intl.formatMessage({ id: "settings.extensions.state.new", defaultMessage: "Not loaded" })
  if (state === "changed") return intl.formatMessage({ id: "settings.extensions.state.changed", defaultMessage: "Update pending" })
  return intl.formatMessage({ id: "settings.extensions.state.error", defaultMessage: "Error" })
}

/**
 * What the background update pass could do about a failed import. Without it the row shows the
 * raw import error and nothing about whether waiting would help.
 */
function repairHint(repair: ExtensionRepairOutcome): ReactNode {
  if (repair === "unavailable") {
    return (
      <FormattedMessage
        id="settings.extensions.repair.unavailable"
        defaultMessage="No build compatible with this version of Operon is published yet. Operon checks again on every launch and loads it as soon as one is."
      />
    )
  }
  if (repair === "unreachable") {
    return (
      <FormattedMessage
        id="settings.extensions.repair.unreachable"
        defaultMessage="Operon could not reach the marketplace to look for a fix. It tries again on the next launch."
      />
    )
  }
  return (
    <FormattedMessage
      id="settings.extensions.repair.failed"
      defaultMessage="The newest published build did not fix this either."
    />
  )
}

function ExtensionRow({ ext, busy, onLoad, onReload, onUnload, onRemove, onConfigure }: {
  ext: OperonExtensionDTO
  busy: boolean
  onLoad: () => void
  onReload: () => void
  onUnload: () => void
  onRemove: () => void
  onConfigure?: () => void
}) {
  const intl = useIntl()
  const name = extensionName(intl, ext.id, ext.name ?? ext.id)
  const description = extensionDescription(intl, ext.id, ext.description)
  // An import that threw leaves the approval standing, so the loader still says `approved`.
  // Saying "Approved" on a row for something that is not running is the whole bug.
  const failed = Boolean(ext.loadError)
  const stateLabel = failed
    ? intl.formatMessage({ id: "settings.extensions.state.loadFailed", defaultMessage: "Failed to load" })
    : extensionStateLabel(intl, ext.state)
  const canLoad = ext.state === "new" || ext.state === "approved"
  const canReload = ext.state === "changed" || ext.state === "loaded"
  const canUnload = ext.state === "loaded"
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {ext.version ? <span className="text-[11px] text-muted-foreground">v{ext.version}</span> : null}
          <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-medium", STATE_CLASS[failed ? "error" : ext.state])}>{stateLabel}</span>
          {ext.attachedSessions > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              <FormattedMessage id="settings.extensions.usedBy" defaultMessage="used by {count, plural, one {# session} other {# sessions}}" values={{ count: ext.attachedSessions }} />
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          <span className="font-mono">{ext.id}</span>
          {ext.engine ? <span> · <FormattedMessage id="settings.extensions.engineRequirement" defaultMessage="engine ≥ {version}" values={{ version: ext.engine }} /></span> : null}
        </div>
        {description ? <div className="mt-1 text-xs text-muted-foreground">{description}</div> : null}
        {ext.error ? <div className="mt-1"><InlineMessage tone="error" message={ext.error} /></div> : null}
        {ext.loadError ? (
          <div className="mt-1 space-y-1">
            <InlineMessage tone="error" message={ext.loadError} />
            {ext.loadRepair ? <div className="pl-5 text-[11px] text-muted-foreground">{repairHint(ext.loadRepair)}</div> : null}
          </div>
        ) : null}
        {ext.state === "changed" ? (
          <div className="mt-1 text-xs text-status-warn">
            <FormattedMessage id="settings.extensions.changedHint" defaultMessage="A new build is installed. Reload to apply it; active sessions switch at a safe run boundary." />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : (
          <>
            {onConfigure ? <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onConfigure}><Settings2 className="h-3.5 w-3.5" /><FormattedMessage id="settings.extensions.configure" defaultMessage="Configure" /></Button> : null}
            {canLoad ? (
              <Button size="sm" variant="secondary" className="h-7 gap-1.5 text-xs" onClick={onLoad} disabled={ext.state === "error"}>
                {failed ? <RefreshCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {failed
                  ? <FormattedMessage id="settings.extensions.retryLoad" defaultMessage="Try again" />
                  : <FormattedMessage id="settings.extensions.load" defaultMessage="Load" />}
              </Button>
            ) : null}
            {canReload ? <Button size="sm" variant={ext.state === "changed" ? "secondary" : "ghost"} className="h-7 gap-1.5 text-xs" onClick={onReload}><RefreshCw className="h-3.5 w-3.5" /><FormattedMessage id="settings.extensions.reload" defaultMessage="Reload" /></Button> : null}
            {canUnload ? <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onUnload}><Square className="h-3.5 w-3.5" /><FormattedMessage id="settings.extensions.unload" defaultMessage="Unload" /></Button> : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-status-error"
              onClick={onRemove}
              title={intl.formatMessage({ id: "settings.extensions.remove", defaultMessage: "Remove" })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function InlineMessage({ tone, message }: { tone: "error" | "success"; message: string }) {
  return (
    <div className={cn("flex items-start gap-2 text-xs", tone === "error" ? "text-status-error" : "text-status-ok")}>
      {tone === "error" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <span>{message}</span>
    </div>
  )
}

function LoadingBlock() {
  return <div className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-border/30 bg-muted/5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /><FormattedMessage id="settings.extensions.loading" defaultMessage="Loading…" /></div>
}

function EmptyBlock({ message }: { message: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border/50 px-4 py-7 text-center text-xs text-muted-foreground">{message}</div>
}
