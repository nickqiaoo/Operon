import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Store,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useAuthedObjectUrl } from "@/hooks/useAuthedObjectUrl"
import { openExternalUrl } from "@/lib/open-external"
import type {
  OperonMarketplaceDetailsDTO,
  OperonMarketplaceEntryDTO,
  OperonMarketplaceInfoDTO,
  OperonMarketplaceMcpServerDTO,
  OperonMcpToolDTO,
  OperonPluginDTO,
  OperonPluginInfoDTO,
  OperonPluginMcpServerDTO,
} from "@/types/plugin"

/**
 * Session-independent plugin management, styled as an app marketplace (à la the ChatGPT apps
 * gallery). The configured registries (Operon config `pluginMarketplaces`) are browsed automatically
 * on open; entries are grouped into Featured + category shelves. Both installed apps and marketplace
 * entries open the SAME detail view — enable/disable, per-MCP toggles, and install all live there.
 * Direct install from a github / zip / path source lives at the bottom.
 */
export function PluginsSettings() {
  // Installed plugins (the local store).
  const [installed, setInstalled] = useState<OperonPluginDTO[]>([])
  const [loadingInstalled, setLoadingInstalled] = useState(false)
  const [installedError, setInstalledError] = useState<string | null>(null)

  // Marketplace browse state.
  const [entries, setEntries] = useState<OperonMarketplaceEntryDTO[] | null>(null)
  const [sources, setSources] = useState<string[]>([])
  const [browseErrors, setBrowseErrors] = useState<Array<{ source: string; message: string }>>([])
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [details, setDetails] = useState<Record<string, OperonMarketplaceDetailsDTO>>({})

  // Install / navigation state.
  const [installing, setInstalling] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Bumped on each browse so a slow detail fetch from a previous browse can't overwrite newer results.
  const browseIdRef = useRef(0)

  const reloadInstalled = useCallback(async () => {
    setLoadingInstalled(true)
    setInstalledError(null)
    try {
      const res = await api.pluginsList()
      if (res.error) throw new Error(res.error)
      setInstalled(res.plugins ?? [])
    } catch (e) {
      setInstalledError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingInstalled(false)
    }
  }, [])

  // Lazily enrich entries with logo/description, in chunks so they appear progressively.
  const loadDetails = useCallback(async (list: OperonMarketplaceEntryDTO[], browseId: number) => {
    const CHUNK = 24
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK).map((e) => e.source)
      try {
        const res = await api.pluginsMarketplaceDetails(chunk)
        if (browseId !== browseIdRef.current) return // a newer browse started — drop stale results
        if (!res.details) continue
        // Cached-repo logos come as a local path — resolve to a servable asset URL for <img>.
        const normalized: Record<string, OperonMarketplaceDetailsDTO> = {}
        for (const [src, d] of Object.entries(res.details)) {
          normalized[src] = d.logoAsset && !d.logoUrl ? { ...d, logoUrl: await api.pluginAssetUrl(d.logoAsset) } : d
        }
        if (browseId !== browseIdRef.current) return
        setDetails((prev) => ({ ...prev, ...normalized }))
      } catch {
        // Best-effort decoration — ignore failures, entries still render without logo/description.
      }
    }
  }, [])

  const browse = useCallback(async () => {
    const browseId = ++browseIdRef.current
    setBrowsing(true)
    setBrowseError(null)
    setDetails({})
    try {
      const res = await api.pluginsMarketplace()
      if (res.error) throw new Error(res.error)
      const list = res.entries ?? []
      setEntries(list)
      setSources(res.sources ?? [])
      setBrowseErrors(res.errors ?? [])
      setHiddenCount(res.hidden ?? 0)
      void loadDetails(list, browseId)
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e))
      setEntries(null)
    } finally {
      setBrowsing(false)
    }
  }, [loadDetails])

  // Open the default library automatically, and load the installed store.
  useEffect(() => {
    void reloadInstalled()
    void browse()
  }, [reloadInstalled, browse])

  const install = useCallback(
    async (src: string, key: string, onDone?: () => void) => {
      if (!src) return
      setInstalling(key)
      setInstallError(null)
      try {
        const res = await api.pluginsInstall(src)
        if (res.error) throw new Error(res.error)
        onDone?.()
        await reloadInstalled()
      } catch (e) {
        setInstallError(e instanceof Error ? e.message : String(e))
      } finally {
        setInstalling(null)
      }
    },
    [reloadInstalled],
  )

  // A marketplace entry is installed when an installed plugin shares its id (install rewrites the
  // source path into the local store, so ids — not sources — are the reliable join key).
  const installedIds = useMemo(() => new Set(installed.map((p) => p.id)), [installed])

  const views = useMemo<MarketEntryView[]>(
    () => (entries ?? []).map((e) => toView(e, details[e.source], installedIds.has(e.id))),
    [entries, details, installedIds],
  )

  // Logo/brand by plugin id — installed apps reuse their marketplace logo (served from the cache).
  const logoById = useMemo(() => {
    const m = new Map<string, { logoUrl?: string; brandColor?: string }>()
    for (const v of views) m.set(v.entry.id, { logoUrl: v.logoUrl, brandColor: v.brandColor })
    return m
  }, [views])

  const selectedView = useMemo(
    () => views.find((v) => v.entry.id === selectedId) ?? null,
    [views, selectedId],
  )

  // Detail view: replaces the gallery in place (in-panel drill-down), shared by installed + market.
  if (selectedId) {
    return (
      <PluginDetail
        id={selectedId}
        marketView={selectedView}
        installed={installed}
        logo={logoById.get(selectedId)}
        installing={installing === selectedId}
        installError={installError}
        onInstall={selectedView ? () => install(selectedView.entry.source, selectedId) : undefined}
        onChanged={reloadInstalled}
        onBack={() => setSelectedId(null)}
      />
    )
  }

  return (
    <div className="space-y-8">
      <p className="text-xs text-muted-foreground">
        <FormattedMessage
          id="settings.plugins.scopeNote"
          defaultMessage="Plugins add skills and MCP servers to the <b>Operon agent only</b> — they don't affect Claude Code, Codex, or other providers."
          values={{
            b: (chunks: ReactNode) => <span className="font-medium text-foreground/80">{chunks}</span>,
          }}
        />
      </p>

      <InstalledStrip
        plugins={installed}
        logoById={logoById}
        loading={loadingInstalled}
        error={installedError}
        onReload={reloadInstalled}
        onOpen={setSelectedId}
      />

      <MarketplaceGallery
        views={views}
        browsing={browsing}
        browseError={browseError}
        browseErrors={browseErrors}
        hiddenCount={hiddenCount}
        sourcesConfigured={sources.length > 0}
        installing={installing}
        onRefresh={browse}
        onOpen={setSelectedId}
        onInstall={install}
      />

      <InstallFromSource installing={installing} installError={installError} onInstall={install} />
    </div>
  )
}

// ── Installed: clickable icon strip ──────────────────────────────────────────
function InstalledStrip({
  plugins,
  logoById,
  loading,
  error,
  onReload,
  onOpen,
}: {
  plugins: OperonPluginDTO[]
  logoById: Map<string, { logoUrl?: string; brandColor?: string }>
  loading: boolean
  error: string | null
  onReload: () => void
  onOpen: (id: string) => void
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">
            <FormattedMessage id="settings.plugins.installed" defaultMessage="Installed" />
          </h2>
          {plugins.length > 0 && <span className="text-xs text-muted-foreground">{plugins.length}</span>}
        </div>
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onReload} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <FormattedMessage id="settings.plugins.refresh" defaultMessage="Refresh" />
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      {!error && plugins.length === 0 && !loading && (
        <div className="rounded-lg border border-dashed border-border/50 p-4 text-center text-xs text-muted-foreground">
          <FormattedMessage
            id="settings.plugins.noneInstalled"
            defaultMessage="No plugins installed yet. Browse the marketplace below to add one."
          />
        </div>
      )}

      {plugins.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {plugins.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onOpen(p.id)}
              title={p.displayName}
              className="flex w-16 flex-col items-center gap-1.5 rounded-lg p-1.5 transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              <div className="relative">
                <PluginLogo url={logoById.get(p.id)?.logoUrl} name={p.displayName} color={logoById.get(p.id)?.brandColor} size="lg" />
                {!p.enabled && (
                  <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-muted px-1 text-[9px] leading-[1.4] text-muted-foreground ring-2 ring-background">
                    <FormattedMessage id="settings.plugins.badgeOff" defaultMessage="off" />
                  </span>
                )}
                {p.hasErrors && (
                  <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 ring-2 ring-background">
                    <AlertTriangle className="h-2 w-2 text-white" />
                  </span>
                )}
              </div>
              <span className="w-full truncate text-center text-[10px] text-muted-foreground">{p.displayName}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Marketplace gallery: Featured + category shelves ─────────────────────────
function MarketplaceGallery({
  views,
  browsing,
  browseError,
  browseErrors,
  hiddenCount,
  sourcesConfigured,
  installing,
  onRefresh,
  onOpen,
  onInstall,
}: {
  views: MarketEntryView[]
  browsing: boolean
  browseError: string | null
  browseErrors: Array<{ source: string; message: string }>
  hiddenCount: number
  sourcesConfigured: boolean
  installing: string | null
  onRefresh: () => void
  onOpen: (id: string) => void
  onInstall: (source: string, key: string) => void
}) {
  const shelves = useMemo(() => groupIntoShelves(views), [views])

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">
            <FormattedMessage id="settings.plugins.marketplace" defaultMessage="Marketplace" />
          </h2>
        </div>
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={onRefresh} disabled={browsing}>
          {browsing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <FormattedMessage id="settings.plugins.refresh" defaultMessage="Refresh" />
        </Button>
      </div>

      {browseError && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {browseError}
        </div>
      )}
      {browseErrors.map((e) => (
        <div key={e.source} className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {e.source}: {e.message}
        </div>
      ))}

      {browsing && views.length === 0 && <GallerySkeleton />}

      {!browsing && views.length === 0 && !browseError && (
        <div className="rounded-lg border border-dashed border-border/50 p-6 text-center text-xs text-muted-foreground">
          {sourcesConfigured ? (
            <FormattedMessage
              id="settings.plugins.emptyMarketplace"
              defaultMessage="No plugins found in the configured marketplaces."
            />
          ) : (
            <FormattedMessage
              id="settings.plugins.noMarketplaceConfigured"
              defaultMessage='No marketplace configured. Add <code>pluginMarketplaces = ["openai/plugins"]</code> to the Operon config tab.'
              values={{ code: (chunks: ReactNode) => <code className="text-[11px]">{chunks}</code> }}
            />
          )}
        </div>
      )}

      {shelves.map((shelf) => (
        <div key={shelf.title} className="space-y-2">
          <h3 className="border-b border-border/40 pb-1.5 text-xs font-semibold text-muted-foreground">
            {shelf.kind === "featured" ? (
              <FormattedMessage id="settings.plugins.shelf.featured" defaultMessage="Featured" />
            ) : shelf.kind === "all" ? (
              <FormattedMessage id="settings.plugins.shelf.all" defaultMessage="All plugins" />
            ) : shelf.kind === "more" ? (
              <FormattedMessage id="settings.plugins.shelf.more" defaultMessage="More" />
            ) : (
              // Category shelves come from marketplace keywords — data, not UI copy.
              shelf.title
            )}
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {shelf.items.map((view) => (
              <PluginCard
                key={view.entry.id}
                view={view}
                installing={installing === view.entry.id}
                installDisabled={installing !== null}
                onOpen={() => onOpen(view.entry.id)}
                onInstall={() => onInstall(view.entry.source, view.entry.id)}
              />
            ))}
          </div>
        </div>
      ))}

      {!browsing && hiddenCount > 0 && (
        <p className="pt-1 text-xs text-muted-foreground">
          <FormattedMessage
            id="settings.plugins.hiddenCount"
            defaultMessage="{count, plural, one {# more plugin is} other {# more plugins are}} hidden — they rely on a ChatGPT app connector the Operon agent can't use."
            values={{ count: hiddenCount }}
          />
        </p>
      )}
    </section>
  )
}

function PluginCard({
  view,
  installing,
  installDisabled,
  onOpen,
  onInstall,
}: {
  view: MarketEntryView
  installing: boolean
  installDisabled: boolean
  onOpen: () => void
  onInstall: () => void
}) {
  const connectorBlocked = view.entry.connectorSupport !== undefined && view.entry.connectorSupport !== "supported"
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-xl border border-border/50 bg-popover/95 px-3 py-2.5 text-left",
        "shadow-card transition-colors hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
      )}
    >
      <PluginLogo url={view.logoUrl} name={view.name} color={view.brandColor} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{view.name}</span>
          {view.requiresAuth && <KeyRound className="h-3 w-3 shrink-0 text-muted-foreground" />}
          {view.entry.connectorSupport && (
            <ConnectorSupportBadge support={view.entry.connectorSupport} />
          )}
        </div>
        {view.description && <div className="truncate text-xs text-muted-foreground">{view.description}</div>}
      </div>
      {view.installed ? (
        <span className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400">
          <Check className="h-3.5 w-3.5" />{" "}
          <FormattedMessage id="settings.plugins.installedBadge" defaultMessage="Installed" />
        </span>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1.5 text-xs"
          disabled={installDisabled || connectorBlocked}
          title={connectorBlocked ? view.entry.connectorReason : undefined}
          onClick={(e) => {
            e.stopPropagation()
            onInstall()
          }}
        >
          {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          <FormattedMessage id="settings.plugins.install" defaultMessage="Install" />
        </Button>
      )}
    </div>
  )
}

// ── Plugin detail (unified: installed + marketplace) ─────────────────────────
function PluginDetail({
  id,
  marketView,
  installed,
  logo,
  installing,
  installError,
  onInstall,
  onChanged,
  onBack,
}: {
  id: string
  marketView: MarketEntryView | null
  installed: OperonPluginDTO[]
  logo?: { logoUrl?: string; brandColor?: string }
  installing: boolean
  installError: string | null
  onInstall?: () => void
  onChanged: () => Promise<void> | void
  onBack: () => void
}) {
  const intl = useIntl()
  const installedPlugin = installed.find((p) => p.id === id) ?? null
  const isInstalled = installedPlugin !== null

  const [info, setInfo] = useState<OperonPluginInfoDTO | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Not-installed: the full detail (example prompts / MCP servers / skills / developer) read straight
  // from the cached marketplace repo, so a plugin can be inspected before installing.
  const marketSource = marketView?.entry.source
  const [marketInfo, setMarketInfo] = useState<OperonMarketplaceInfoDTO | null>(null)
  const [marketInfoLoading, setMarketInfoLoading] = useState(false)

  const loadInfo = useCallback(async () => {
    if (!isInstalled) {
      setInfo(null)
      return
    }
    setInfoLoading(true)
    try {
      const res = await api.pluginsInfo(id)
      setInfo(res.info ?? null)
    } catch {
      setInfo(null)
    } finally {
      setInfoLoading(false)
    }
  }, [id, isInstalled])

  useEffect(() => {
    void loadInfo()
  }, [loadInfo])

  useEffect(() => {
    if (isInstalled || !marketSource) {
      setMarketInfo(null)
      return
    }
    let cancelled = false
    setMarketInfoLoading(true)
    setMarketInfo(null)
    void (async () => {
      try {
        const res = await api.pluginsMarketplaceInfo(marketSource)
        if (!cancelled) setMarketInfo(res.info ?? null)
      } catch {
        if (!cancelled) setMarketInfo(null)
      } finally {
        if (!cancelled) setMarketInfoLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isInstalled, marketSource])

  const run = async (key: string, fn: () => Promise<{ error?: string }>, opts?: { reloadInfo?: boolean; back?: boolean }) => {
    setBusy(key)
    setActionError(null)
    try {
      const res = await fn()
      if (res.error) throw new Error(res.error)
      await onChanged()
      if (opts?.reloadInfo) await loadInfo()
      if (opts?.back) onBack()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // ── MCP OAuth: open the provider login in the browser, then poll until authorized ──
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const connectCancelled = useRef(false)
  useEffect(() => () => { connectCancelled.current = true }, [])

  const connectServer = async (server: string) => {
    setConnectError(null)
    setConnecting(server)
    connectCancelled.current = false
    try {
      const res = await api.pluginsMcpAuthBegin(id, server)
      if (res.error) throw new Error(res.error)
      if (res.alreadyAuthorized) {
        await loadInfo()
        return
      }
      if (res.authorizationUrl) openExternalUrl(res.authorizationUrl)
      // The framework's local callback server catches the redirect; poll status until tokens land.
      const deadline = Date.now() + 3 * 60 * 1000
      while (!connectCancelled.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        if (connectCancelled.current) return
        const st = await api.pluginsMcpAuthStatus(id)
        const s = st.servers?.find((x) => x.server === server)
        if (s?.authenticated) {
          await loadInfo()
          return
        }
        if (s && !s.pending) {
          // Flow ended without success (browser closed / denied / errored).
          setConnectError(
            intl.formatMessage({
              id: "settings.plugins.auth.incomplete",
              defaultMessage: "Sign-in didn't complete. Try Connect again.",
            }),
          )
          return
        }
      }
      if (!connectCancelled.current) {
        setConnectError(
          intl.formatMessage({
            id: "settings.plugins.auth.timeout",
            defaultMessage: "Sign-in timed out. Try Connect again.",
          }),
        )
      }
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!connectCancelled.current) setConnecting(null)
    }
  }

  const cancelConnect = (server: string) => {
    connectCancelled.current = true
    setConnecting(null)
    void api.pluginsMcpAuthCancel(id, server)
  }

  const name = marketView?.name ?? info?.displayName ?? installedPlugin?.displayName ?? id
  const tagline = marketView?.description ?? info?.tagline
  const description = info?.description ?? marketInfo?.description
  const version = installedPlugin?.version ?? info?.version ?? marketInfo?.version ?? marketView?.entry.version
  const brand = logo?.brandColor ?? info?.brandColor ?? marketInfo?.brandColor
  const homepage = marketView?.entry.homepage ?? info?.homepage
  const website = info?.website ?? homepage ?? marketInfo?.website
  const privacy = info?.privacyPolicy ?? marketInfo?.privacyPolicy
  const category =
    info?.category ?? marketInfo?.category ?? (marketView && marketView.category !== "Other" ? marketView.category : undefined)
  const developer = info?.developer ?? marketInfo?.developer
  const examplePrompts = info?.examplePrompts ?? marketInfo?.examplePrompts ?? []
  const requiresAuth = marketView?.requiresAuth ?? false
  const connectorBlocked =
    marketView?.entry.connectorSupport !== undefined && marketView.entry.connectorSupport !== "supported"
  const needsAuthServers = (info?.mcpServers ?? []).filter((s) => s.requiresAuth && !s.authenticated)
  const blockedInstalledApps = (info?.apps ?? []).filter((app) => app.required && app.support !== "supported")

  return (
    <div className="space-y-8">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />{" "}
        <FormattedMessage id="settings.plugins.back" defaultMessage="Back" />
      </button>

      {/* Header */}
      <div className="flex items-start gap-4">
        <PluginLogo url={logo?.logoUrl} name={name} color={brand} size="xl" />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">{name}</h2>
            {requiresAuth && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <KeyRound className="h-3 w-3" />{" "}
                <FormattedMessage id="settings.plugins.requiresSignIn" defaultMessage="Requires sign-in" />
              </span>
            )}
          </div>
          {tagline && <p className="mt-1 text-sm text-muted-foreground">{tagline}</p>}
        </div>
        {/* Primary action */}
        {isInstalled ? (
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Switch
              checked={installedPlugin?.enabled ?? false}
              disabled={busy !== null}
              onCheckedChange={(enabled) => run("enabled", () => api.pluginsSetEnabled(id, enabled))}
            />
            <span className="text-xs text-muted-foreground">
              {installedPlugin?.enabled ? (
                <FormattedMessage id="settings.plugins.on" defaultMessage="On" />
              ) : (
                <FormattedMessage id="settings.plugins.off" defaultMessage="Off" />
              )}
            </span>
          </div>
        ) : onInstall ? (
          <Button
            size="sm"
            className="h-9 shrink-0 gap-1.5 rounded-full px-4"
            onClick={onInstall}
            disabled={installing || connectorBlocked}
            title={connectorBlocked ? marketView?.entry.connectorReason : undefined}
          >
            {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <FormattedMessage id="settings.plugins.install" defaultMessage="Install" />
          </Button>
        ) : null}
      </div>

      {/* Brand hero with example prompts — the visual focal point */}
      {examplePrompts.length > 0 && (
        <div className="overflow-hidden rounded-2xl p-5 sm:p-8" style={heroBackground(brand)}>
          <div className="mx-auto flex max-w-2xl flex-col gap-2.5">
            {examplePrompts.map((p) => (
              <div
                key={p}
                className="flex items-center gap-3 rounded-2xl border border-white/50 bg-background/75 px-4 py-3 shadow-card backdrop-blur-sm dark:border-white/10 dark:bg-background/60"
              >
                <PluginLogo url={logo?.logoUrl} name={name} color={brand} size="sm" />
                <span className="shrink-0 text-sm font-semibold" style={brand ? { color: brand } : undefined}>
                  {name}
                </span>
                <span className="flex-1 text-sm text-foreground/90">{p}</span>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/70 text-muted-foreground">
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {description && <p className="text-[15px] leading-relaxed text-muted-foreground">{description}</p>}

      {!isInstalled && connectorBlocked && marketView?.entry.connectorReason && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <div className="text-sm font-medium">
              <FormattedMessage id="settings.plugins.connectorUnavailable" defaultMessage="Connector unavailable" />
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{marketView.entry.connectorReason}</div>
          </div>
        </div>
      )}

      {isInstalled && blockedInstalledApps.map((app) => (
        <div key={app.alias} className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <div className="text-sm font-medium">
              <FormattedMessage id="settings.plugins.connectorUnavailable" defaultMessage="Connector unavailable" />
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {app.reason ?? "This required connector is not supported."}
            </div>
          </div>
        </div>
      ))}

      {/* Connect CTA — appears when an installed plugin has an OAuth server that isn't authorized yet */}
      {isInstalled && needsAuthServers.length > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
            <KeyRound className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              <FormattedMessage id="settings.plugins.connectAccount" defaultMessage="Connect your account" />
            </div>
            <div className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.plugins.connectAccountDesc"
                defaultMessage="Sign in to {name} so the Operon agent can use this plugin."
                values={{ name }}
              />
            </div>
          </div>
          {connecting ? (
            <div className="flex shrink-0 items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                <FormattedMessage id="settings.plugins.waiting" defaultMessage="Waiting…" />
              </span>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => cancelConnect(connecting)}>
                <FormattedMessage id="settings.plugins.cancel" defaultMessage="Cancel" />
              </Button>
            </div>
          ) : (
            <Button size="sm" className="h-8 shrink-0 gap-1.5 rounded-full px-4" onClick={() => connectServer(needsAuthServers[0]!.name)}>
              <KeyRound className="h-3.5 w-3.5" />{" "}
              <FormattedMessage id="settings.plugins.connect" defaultMessage="Connect" />
            </Button>
          )}
        </div>
      )}
      {connectError && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {connectError}
        </div>
      )}

      {/* Installed-only: MCP servers + skills + info + remove */}
      {isInstalled && (
        <>
          <DetailSection
            title={<FormattedMessage id="settings.plugins.section.mcpServers" defaultMessage="MCP servers" />}
            count={info?.mcpServers.length}
            loading={infoLoading}
          >
            {info && info.mcpServers.length > 0 ? (
              <div className="divide-y divide-border/30">
                {info.mcpServers.map((s) => (
                  <McpServerRow
                    key={s.name}
                    pluginId={id}
                    server={s}
                    logoUrl={logo?.logoUrl}
                    brand={brand}
                    pluginEnabled={installedPlugin?.enabled ?? false}
                    busy={busy}
                    connecting={connecting}
                    onConnect={() => connectServer(s.name)}
                    onCancelConnect={() => cancelConnect(s.name)}
                    onDisconnect={() => run(`disconnect:${s.name}`, () => api.pluginsMcpAuthDisconnect(id, s.name), { reloadInfo: true })}
                    onToggleEnabled={(enabled) => run(`mcp:${s.name}`, () => api.pluginsSetMcpEnabled(id, s.name, enabled), { reloadInfo: true })}
                  />
                ))}
              </div>
            ) : (
              <EmptyLine>
                <FormattedMessage id="settings.plugins.noMcpServers" defaultMessage="No MCP servers." />
              </EmptyLine>
            )}
          </DetailSection>

          <DetailSection
            title={<FormattedMessage id="settings.plugins.section.skills" defaultMessage="Skills" />}
            count={info?.skills.length}
            loading={infoLoading}
          >
            {info && info.skills.length > 0 ? (
              <div className="divide-y divide-border/30">
                {info.skills.map((s) => (
                  <SkillRow key={s} skill={s} logoUrl={logo?.logoUrl} brand={brand} fetchContent={() => api.pluginsSkill(id, s)} />
                ))}
              </div>
            ) : (
              <EmptyLine>
                <FormattedMessage id="settings.plugins.noSkills" defaultMessage="No skills." />
              </EmptyLine>
            )}
          </DetailSection>

          <DetailSection title={<FormattedMessage id="settings.plugins.section.info" defaultMessage="Info" />}>
            <InfoList developer={developer} category={category} version={version} website={website} privacy={privacy} installedAt={info?.installedAt} />
          </DetailSection>

          <div className="flex items-center justify-between border-t border-border/40 pt-5">
            <span className="text-xs text-muted-foreground">
              <FormattedMessage
                id="settings.plugins.removeHint"
                defaultMessage="Removing uninstalls the plugin for new chat sessions."
              />
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy !== null}
              onClick={() => run("remove", () => api.pluginsRemove(id), { back: true })}
            >
              {busy === "remove" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              <FormattedMessage id="settings.plugins.remove" defaultMessage="Remove" />
            </Button>
          </div>
        </>
      )}

      {/* Not-installed: preview the plugin's capabilities (read from the cached repo) before installing. */}
      {!isInstalled && (
        <>
          {marketInfoLoading && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />{" "}
              <FormattedMessage id="settings.plugins.loading" defaultMessage="Loading…" />
            </div>
          )}

          {marketInfo && marketInfo.mcpServers.length > 0 && (
            <DetailSection
              title={<FormattedMessage id="settings.plugins.section.mcpServers" defaultMessage="MCP servers" />}
              count={marketInfo.mcpServers.length}
            >
              <div className="divide-y divide-border/30">
                {marketInfo.mcpServers.map((s) => (
                  <MarketMcpRow key={s.name} server={s} logoUrl={logo?.logoUrl} brand={brand} />
                ))}
              </div>
            </DetailSection>
          )}

          {marketInfo && marketInfo.skills.length > 0 && marketSource && (
            <DetailSection
              title={<FormattedMessage id="settings.plugins.section.skills" defaultMessage="Skills" />}
              count={marketInfo.skills.length}
            >
              <div className="divide-y divide-border/30">
                {marketInfo.skills.map((s) => (
                  <SkillRow key={s} skill={s} logoUrl={logo?.logoUrl} brand={brand} fetchContent={() => api.pluginsMarketplaceSkill(marketSource, s)} />
                ))}
              </div>
            </DetailSection>
          )}

          {(developer || category || version || website) && (
            <DetailSection title={<FormattedMessage id="settings.plugins.section.info" defaultMessage="Info" />}>
              <InfoList developer={developer} category={category} version={version} website={website} privacy={privacy} />
            </DetailSection>
          )}
        </>
      )}

      {(actionError || installError) && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {actionError ?? installError}
        </div>
      )}
    </div>
  )
}

function DetailSection({
  title,
  count,
  loading,
  children,
}: {
  title: ReactNode
  count?: number
  loading?: boolean
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 border-b border-border/40 pb-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {count !== undefined && <span className="text-sm text-muted-foreground">{count}</span>}
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {children}
    </section>
  )
}

function InfoList({
  developer,
  category,
  version,
  website,
  privacy,
  installedAt,
}: {
  developer?: string
  category?: string
  version?: string
  website?: string
  privacy?: string
  installedAt?: string
}) {
  const link = (href: string, label: ReactNode) => (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground hover:text-primary">
      {label} <ExternalLink className="h-3 w-3" />
    </a>
  )
  return (
    <dl className="grid grid-cols-[7rem_1fr] gap-y-2.5 text-sm">
      {developer && (<><dt className="text-muted-foreground"><FormattedMessage id="settings.plugins.info.developer" defaultMessage="Developer" /></dt><dd>{developer}</dd></>)}
      {category && (<><dt className="text-muted-foreground"><FormattedMessage id="settings.plugins.info.category" defaultMessage="Category" /></dt><dd>{category}</dd></>)}
      {version && (<><dt className="text-muted-foreground"><FormattedMessage id="settings.plugins.info.version" defaultMessage="Version" /></dt><dd>v{version}</dd></>)}
      <dt className="text-muted-foreground"><FormattedMessage id="settings.plugins.info.scope" defaultMessage="Scope" /></dt>
      <dd className="text-muted-foreground"><FormattedMessage id="settings.plugins.info.scopeValue" defaultMessage="Operon agent only" /></dd>
      {website && (<><dt className="text-muted-foreground"><FormattedMessage id="settings.plugins.info.website" defaultMessage="Website" /></dt><dd>{link(website, prettyHost(website))}</dd></>)}
      {privacy && (<><dt className="text-muted-foreground"><FormattedMessage id="settings.plugins.info.privacy" defaultMessage="Privacy" /></dt><dd>{link(privacy, <FormattedMessage id="settings.plugins.info.privacyPolicy" defaultMessage="Privacy policy" />)}</dd></>)}
      {installedAt && (<><dt className="text-muted-foreground"><FormattedMessage id="settings.plugins.info.installed" defaultMessage="Installed" /></dt><dd>{formatDate(installedAt)}</dd></>)}
    </dl>
  )
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <div className="text-xs text-muted-foreground">{children}</div>
}

// One MCP server row: auth/enable controls on the right. Clicking the row opens a dialog with the
// server's tools (lazy-fetched by connecting — only openable once authorized, since tools/list needs
// a session).
function McpServerRow({
  pluginId,
  server,
  logoUrl,
  brand,
  pluginEnabled,
  busy,
  connecting,
  onConnect,
  onCancelConnect,
  onDisconnect,
  onToggleEnabled,
}: {
  pluginId: string
  server: OperonPluginMcpServerDTO
  logoUrl?: string
  brand?: string
  pluginEnabled: boolean
  busy: string | null
  connecting: string | null
  onConnect: () => void
  onCancelConnect: () => void
  onDisconnect: () => void
  onToggleEnabled: (enabled: boolean) => void
}) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)
  const [tools, setTools] = useState<OperonMcpToolDTO[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canOpen = !server.requiresAuth || server.authenticated

  const openDialog = async () => {
    setOpen(true)
    if (tools === null && !loading) {
      setLoading(true)
      setError(null)
      try {
        const res = await api.pluginsMcpTools(pluginId, server.name)
        if (res.error) throw new Error(res.error)
        setTools(res.tools ?? [])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    }
  }

  const meta =
    server.transport === "http"
      ? intl.formatMessage({ id: "settings.plugins.mcp.remote", defaultMessage: "Remote (HTTP)" })
      : intl.formatMessage({ id: "settings.plugins.mcp.local", defaultMessage: "Local (stdio)" })
  const write = (tools ?? []).filter((t) => t.write)
  const read = (tools ?? []).filter((t) => !t.write)

  const identity = (
    <>
      <PluginLogo url={logoUrl} name={server.name} color={brand} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{server.name}</span>
          {server.requiresAuth && server.authenticated && (
            <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
              <Check className="h-3 w-3" />{" "}
              <FormattedMessage id="settings.plugins.mcp.connected" defaultMessage="Connected" />
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">{meta}</div>
      </div>
    </>
  )

  return (
    <div className="flex items-center gap-3 py-3">
      {canOpen ? (
        <button
          type="button"
          onClick={openDialog}
          className="group -mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/50"
        >
          {identity}
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{identity}</div>
      )}
      {server.requiresAuth && !server.authenticated ? (
        connecting === server.name ? (
          <Button size="sm" variant="ghost" className="h-8 shrink-0 gap-1.5 text-xs" onClick={onCancelConnect}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />{" "}
            <FormattedMessage id="settings.plugins.cancel" defaultMessage="Cancel" />
          </Button>
        ) : (
          <Button size="sm" variant="secondary" className="h-8 shrink-0 gap-1.5" disabled={connecting !== null} onClick={onConnect}>
            <KeyRound className="h-3.5 w-3.5" />{" "}
            <FormattedMessage id="settings.plugins.connect" defaultMessage="Connect" />
          </Button>
        )
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          {server.requiresAuth && server.authenticated && (
            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" disabled={busy !== null} onClick={onDisconnect}>
              <FormattedMessage id="settings.plugins.disconnect" defaultMessage="Disconnect" />
            </Button>
          )}
          <Switch checked={server.enabled} disabled={busy !== null || !pluginEnabled} onCheckedChange={onToggleEnabled} />
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="space-y-0 border-b border-border/40 p-5 text-left">
            <div className="flex items-center gap-3">
              <PluginLogo url={logoUrl} name={server.name} color={brand} size="lg" />
              <div className="min-w-0">
                <DialogTitle className="text-base">
                  {server.name}{" "}
                  <span className="font-normal text-muted-foreground">
                    <FormattedMessage id="settings.plugins.mcp.serverLabel" defaultMessage="MCP server" />
                  </span>
                </DialogTitle>
                <DialogDescription className="text-xs">
                  {meta}
                  {tools ? (
                    <FormattedMessage
                      id="settings.plugins.mcp.toolCounts"
                      defaultMessage=" · {total} tools ({write} write, {read} read)"
                      values={{ total: tools.length, write: write.length, read: read.length }}
                    />
                  ) : (
                    ""
                  )}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="overflow-auto p-5">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />{" "}
                <FormattedMessage id="settings.plugins.mcp.loadingTools" defaultMessage="Loading tools…" />
              </div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {error}
              </div>
            ) : tools && tools.length > 0 ? (
              <div className="space-y-5">
                {write.length > 0 && (
                  <ToolGroup
                    title={<FormattedMessage id="settings.plugins.mcp.toolsWrite" defaultMessage="Write" />}
                    tools={write}
                  />
                )}
                {read.length > 0 && (
                  <ToolGroup
                    title={<FormattedMessage id="settings.plugins.mcp.toolsRead" defaultMessage="Read" />}
                    tools={read}
                  />
                )}
              </div>
            ) : (
              <EmptyLine>
                <FormattedMessage id="settings.plugins.mcp.noTools" defaultMessage="No tools reported." />
              </EmptyLine>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ToolGroup({ title, tools }: { title: ReactNode; tools: OperonMcpToolDTO[] }) {
  return (
    <div className="space-y-2.5">
      <div className="text-xs font-semibold text-muted-foreground">
        {title} <span className="text-muted-foreground/60">{tools.length}</span>
      </div>
      <div className="space-y-3">
        {tools.map((t) => (
          <div key={t.name} className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,12rem)_1fr]">
            <code className="text-xs text-foreground/80">{t.name}</code>
            {t.description && <span className="text-xs leading-relaxed text-muted-foreground">{t.description}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// A read-only MCP server row for a not-yet-installed plugin: its tools can't be listed until the
// plugin is installed (and any OAuth server authorized), so this just previews name/transport/auth.
function MarketMcpRow({ server, logoUrl, brand }: { server: OperonMarketplaceMcpServerDTO; logoUrl?: string; brand?: string }) {
  const intl = useIntl()
  const meta =
    server.transport === "http"
      ? intl.formatMessage({ id: "settings.plugins.mcp.remote", defaultMessage: "Remote (HTTP)" })
      : intl.formatMessage({ id: "settings.plugins.mcp.local", defaultMessage: "Local (stdio)" })
  return (
    <div className="flex items-center gap-3 py-3">
      <PluginLogo url={logoUrl} name={server.name} color={brand} size="md" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{server.name}</div>
        <div className="text-xs text-muted-foreground">{meta}</div>
      </div>
      {server.requiresAuth && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          <KeyRound className="h-3 w-3" />{" "}
          <FormattedMessage id="settings.plugins.requiresSignIn" defaultMessage="Requires sign-in" />
        </span>
      )}
    </div>
  )
}

// One skill row: clicking opens a dialog rendering its SKILL.md. The fetcher differs for installed
// plugins (read from the store) vs marketplace entries (read from the cached repo).
function SkillRow({
  skill,
  logoUrl,
  brand,
  fetchContent,
}: {
  skill: string
  logoUrl?: string
  brand?: string
  fetchContent: () => Promise<{ content?: string; error?: string }>
}) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openDialog = async () => {
    setOpen(true)
    if (content === null && !loading) {
      setLoading(true)
      setError(null)
      try {
        const res = await fetchContent()
        if (res.error) throw new Error(res.error)
        setContent(res.content ?? "")
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <>
      <button type="button" onClick={openDialog} className="group -mx-2 flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-muted/50">
        <PluginLogo url={logoUrl} name={skill} color={brand} size="md" />
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{skill}</div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="space-y-0 border-b border-border/40 p-5 text-left">
            <div className="flex items-center gap-3">
              <PluginLogo url={logoUrl} name={skill} color={brand} size="lg" />
              <DialogTitle className="text-base">
                {skill}{" "}
                <span className="font-normal text-muted-foreground">
                  <FormattedMessage id="settings.plugins.skillLabel" defaultMessage="Skill" />
                </span>
              </DialogTitle>
            </div>
          </DialogHeader>
          <div className="overflow-auto p-5">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />{" "}
                <FormattedMessage id="settings.plugins.loading" defaultMessage="Loading…" />
              </div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {error}
              </div>
            ) : content ? (
              <MarkdownRenderer content={content} className="text-sm" />
            ) : (
              <EmptyLine>
                <FormattedMessage id="settings.plugins.emptySkill" defaultMessage="Empty skill." />
              </EmptyLine>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// A soft, brand-tinted diagonal wash for the detail hero. Falls back to indigo for a missing/odd color.
function heroBackground(brand?: string): CSSProperties {
  const c = brand && /^#[0-9a-fA-F]{6}$/.test(brand) ? brand : "#6366f1"
  return { backgroundImage: `linear-gradient(120deg, ${c}40 0%, ${c}1f 42%, ${c}0a 100%)` }
}

// ── Install from a raw source (bottom) ───────────────────────────────────────
function InstallFromSource({
  installing,
  installError,
  onInstall,
}: {
  installing: string | null
  installError: string | null
  onInstall: (source: string, key: string, onDone?: () => void) => void
}) {
  const intl = useIntl()
  const [source, setSource] = useState("")
  return (
    <section className="space-y-3 rounded-xl border border-border/40 bg-muted/10 p-5">
      <div className="flex items-start gap-3">
        <Download className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1">
          <h2 className="text-sm font-semibold mb-1">
            <FormattedMessage id="settings.plugins.installFromSource" defaultMessage="Install from a source" />
          </h2>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="settings.plugins.installFromSourceDesc"
              defaultMessage="Install a plugin directly from a github repo, a zip URL, or an absolute path — no marketplace required."
            />
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.plugins.sourcePlaceholder",
            defaultMessage: "github / zip URL / absolute path",
          })}
          className="h-8 border-border/50 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim()) onInstall(source.trim(), "__source__", () => setSource(""))
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-8 gap-1.5 shrink-0"
          onClick={() => onInstall(source.trim(), "__source__", () => setSource(""))}
          disabled={installing !== null || !source.trim()}
        >
          {installing === "__source__" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          <FormattedMessage id="settings.plugins.install" defaultMessage="Install" />
        </Button>
      </div>
      {installError && installing === null && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {installError}
        </div>
      )}
    </section>
  )
}

function GallerySkeleton() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-20 rounded bg-muted/50" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/10 px-3 py-2.5">
            <div className="h-10 w-10 shrink-0 rounded-lg bg-muted/50" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-24 rounded bg-muted/50" />
              <div className="h-2.5 w-36 rounded bg-muted/40" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Plugin logo: the manifest image when available, otherwise a brand-coloured initial fallback.
function PluginLogo({
  url,
  name,
  color,
  size = "md",
}: {
  url?: string
  name: string
  color?: string
  size?: "sm" | "md" | "lg" | "xl"
}) {
  const [failed, setFailed] = useState(false)
  // A cached-repo logo is served by our own backend, which on web means the
  // broker — and the broker wants a bearer header no <img src> can send. Fetch
  // those for a blob: URL; manifest logos are plain external URLs, left alone.
  const viaBroker =
    __APP_TARGET__ === "web" && !!url && url.includes("/api/plugins/asset") ? url : null
  const objectUrl = useAuthedObjectUrl(viaBroker)
  const src = viaBroker ? objectUrl : url
  const dim =
    size === "xl"
      ? "h-16 w-16 rounded-2xl text-2xl"
      : size === "lg"
        ? "h-10 w-10 rounded-lg text-sm"
        : size === "sm"
          ? "h-5 w-5 rounded-md text-[9px]"
          : "h-8 w-8 rounded-md text-[11px]"
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("shrink-0 border border-border/40 bg-background object-contain", dim)}
      />
    )
  }
  return (
    <div className={cn("flex shrink-0 items-center justify-center font-semibold text-white", dim)} style={{ backgroundColor: color ?? "#94a3b8" }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  )
}

// ── View model + grouping helpers ────────────────────────────────────────────
interface MarketEntryView {
  entry: OperonMarketplaceEntryDTO
  name: string
  description?: string
  logoUrl?: string
  brandColor?: string
  category: string
  requiresAuth: boolean
  installed: boolean
}

function ConnectorSupportBadge({ support }: { support: NonNullable<OperonMarketplaceEntryDTO["connectorSupport"]> }) {
  if (support === "supported") {
    return (
      <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
        <FormattedMessage id="settings.plugins.connectorCompatible" defaultMessage="Compatible" />
      </span>
    )
  }
  const label = support === "setup-required"
    ? <FormattedMessage id="settings.plugins.setupRequired" defaultMessage="Setup required" />
    : support === "adapter-required"
      ? <FormattedMessage id="settings.plugins.adapterRequired" defaultMessage="Adapter required" />
      : <FormattedMessage id="settings.plugins.unsupported" defaultMessage="Unsupported" />
  return (
    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
      {label}
    </span>
  )
}

function toView(entry: OperonMarketplaceEntryDTO, details: OperonMarketplaceDetailsDTO | undefined, installed: boolean): MarketEntryView {
  return {
    entry,
    name: details?.displayName ?? entry.displayName,
    description: details?.description ?? entry.description,
    logoUrl: details?.logoUrl,
    brandColor: details?.brandColor,
    category: deriveCategory(entry),
    requiresAuth: requiresAuth(entry),
    installed,
  }
}

// Well-known OAuth/API connectors whose plugins prompt for authorization. This is a client-side
// heuristic until the marketplace surfaces real auth metadata (see planned OAuth MCP support).
const AUTH_CONNECTORS = [
  "linear", "github", "gitlab", "google", "gmail", "gcal", "calendar", "drive", "notion", "slack",
  "atlassian", "jira", "confluence", "figma", "netlify", "vercel", "sentry", "stripe", "hubspot",
  "salesforce", "asana", "trello", "airtable", "dropbox", "box", "zoom", "intercom", "oauth",
]

function requiresAuth(entry: OperonMarketplaceEntryDTO): boolean {
  const haystack = [entry.id, entry.displayName, entry.description ?? "", ...(entry.keywords ?? [])].join(" ").toLowerCase()
  return AUTH_CONNECTORS.some((c) => haystack.includes(c))
}

function deriveCategory(entry: OperonMarketplaceEntryDTO): string {
  const first = entry.keywords?.[0]
  if (!first) return "Other"
  return first.charAt(0).toUpperCase() + first.slice(1)
}

interface Shelf {
  /** Doubles as the React key. For `category` shelves it is also the rendered label. */
  title: string
  /** Fixed shelves are translated at render; `category` titles come from marketplace keywords. */
  kind: "featured" | "all" | "more" | "category"
  items: MarketEntryView[]
}

/**
 * Group entries into gallery shelves. A "Featured" shelf comes first (tier-flagged entries, else the
 * first few), then category shelves derived from keywords. When categories are too sparse to be
 * useful, everything falls into a single "All plugins" shelf so the gallery never looks fragmented.
 */
function groupIntoShelves(views: MarketEntryView[]): Shelf[] {
  if (views.length === 0) return []

  const FEATURED_TIERS = new Set(["featured", "official", "verified", "recommended"])
  let featured = views.filter((v) => v.entry.tier && FEATURED_TIERS.has(v.entry.tier.toLowerCase()))
  if (featured.length === 0) featured = views.slice(0, Math.min(6, views.length))
  const featuredSet = new Set(featured.map((v) => v.entry.source))
  const rest = views.filter((v) => !featuredSet.has(v.entry.source))

  const byCategory = new Map<string, MarketEntryView[]>()
  for (const v of rest) {
    const list = byCategory.get(v.category) ?? []
    list.push(v)
    byCategory.set(v.category, list)
  }
  const namedCategories = [...byCategory.keys()].filter((c) => c !== "Other")

  const shelves: Shelf[] = []
  if (featured.length > 0) shelves.push({ title: "Featured", kind: "featured", items: featured })

  // Not enough real categories to be worth splitting — keep the tail in one shelf.
  if (namedCategories.length < 2) {
    if (rest.length > 0) shelves.push({ title: "All plugins", kind: "all", items: rest })
    return shelves
  }

  for (const [title, items] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const isOther = title === "Other"
    shelves.push({ title: isOther ? "More" : title, kind: isOther ? "more" : "category", items })
  }
  return shelves
}

function prettyHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "")
  } catch {
    return url
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}
