import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { BarChart3, CalendarClock, FolderTree, Loader2, LogOut, Monitor, RefreshCw, Settings, Trash2 } from "lucide-react"
import { FormattedMessage, defineMessages, useIntl } from "react-intl"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useThemeStore } from "@/stores/theme-store"
import { useBackHandler } from "@/hooks/useAndroidBackButton"
import { SettingsPage } from "@/components/settings/SettingsPage"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { isAnalyticsOptedOut, setAnalyticsOptedOut } from "@/lib/analytics"
import { clearSelectedNode, deleteAccount, fetchNodes, getSelectedNodeId, getSelectedNodeLabel, logout, type WebNode } from "@/lib/web-auth"
import { resetNodeScopedCaches } from "@/lib/node-cache-reset"
import { MobileCronjobScreen } from "./MobileCronjobScreen"
import { MobileFilesScreen } from "./MobileFilesScreen"

type Theme = "light" | "dark" | "system"
const THEMES: Theme[] = ["light", "dark", "system"]

const THEME_LABELS = defineMessages({
  light: { id: "mobile.more.theme.light", defaultMessage: "Light" },
  dark: { id: "mobile.more.theme.dark", defaultMessage: "Dark" },
  system: { id: "mobile.more.theme.system", defaultMessage: "System" },
})

/**
 * Catch-all surface: appearance, full settings (reuses the desktop
 * {@link SettingsPage} overlay) and workspace/automation entries.
 */
export function MobileMoreScreen() {
  const intl = useIntl()
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [cronjobOpen, setCronjobOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  // Real machine status, fetched once when this screen mounts (i.e. each time
  // the user opens More). Starts in "checking" until fetchNodes() resolves.
  const [node, setNode] = useState<WebNode | null>(null)
  const [nodeLoading, setNodeLoading] = useState(__APP_TARGET__ === "web")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [analyticsOn, setAnalyticsOn] = useState(() => !isAnalyticsOptedOut())

  // Android back closes whichever full-screen overlay is up. These sit above
  // the shell's own fallback, so back never skips past an open panel.
  useBackHandler(settingsOpen, () => setSettingsOpen(false))
  useBackHandler(cronjobOpen, () => setCronjobOpen(false))
  useBackHandler(filesOpen, () => setFilesOpen(false))
  useBackHandler(confirmDelete && !deleting, () => setConfirmDelete(false))

  useEffect(() => {
    if (__APP_TARGET__ !== "web") return
    let active = true
    const selectedId = getSelectedNodeId()
    setNodeLoading(true)
    void fetchNodes()
      .then((nodes) => {
        if (active) setNode(nodes.find((n) => n.nodeId === selectedId) ?? null)
      })
      .finally(() => {
        if (active) setNodeLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  // Forget the chosen node and reload — the web auth gate then shows the
  // machine picker again (boot() sees authed + no node → picker phase).
  const switchMachine = () => {
    clearSelectedNode()
    // The reload alone would not clear the persisted project tree, which is
    // scoped to the node we are leaving.
    resetNodeScopedCaches()
    window.location.reload()
  }

  const runDeleteAccount = async () => {
    setDeleting(true)
    // On success this navigates away, so there is no success state to render.
    const ok = await deleteAccount()
    if (!ok) {
      setDeleting(false)
      setConfirmDelete(false)
      toast.error(
        intl.formatMessage({
          id: "mobile.more.deleteAccount.failed",
          defaultMessage: "Couldn't delete your account. Try again.",
        })
      )
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6 p-4">
        {__APP_TARGET__ === "web" && (
          <Section title={<FormattedMessage id="mobile.more.machine" defaultMessage="Machine" />}>
            <div className="overflow-hidden rounded-lg border border-border/40 bg-muted/10">
              <div className="flex items-center gap-3 px-4 py-3">
                <Monitor className="size-4 text-muted-foreground/70" />
                <span className="truncate text-sm text-foreground/85">
                  {node?.label || getSelectedNodeLabel() || intl.formatMessage({ id: "mobile.more.machineFallback", defaultMessage: "machine" })}
                </span>
                <MachineStatusBadge loading={nodeLoading} node={node} />
              </div>
              <button
                type="button"
                onClick={switchMachine}
                className="flex w-full items-center gap-3 border-t border-border/40 px-4 py-3 text-left hover:bg-muted/30"
              >
                <RefreshCw className="size-4 text-muted-foreground/70" />
                <span className="text-sm text-foreground/85">
                  <FormattedMessage id="mobile.more.switchMachine" defaultMessage="Switch machine" />
                </span>
              </button>
              <button
                type="button"
                onClick={() => logout()}
                className="flex w-full items-center gap-3 border-t border-border/40 px-4 py-3 text-left hover:bg-muted/30"
              >
                <LogOut className="size-4 text-muted-foreground/70" />
                <span className="text-sm text-foreground/85">
                  <FormattedMessage id="mobile.more.signOut" defaultMessage="Sign out" />
                </span>
              </button>
            </div>
          </Section>
        )}

        <Section title={<FormattedMessage id="mobile.more.appearance" defaultMessage="Appearance" />}>
          <div className="flex rounded-lg bg-muted/40 p-0.5">
            {THEMES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTheme(t)}
                className={cn(
                  "flex-1 rounded-md py-1.5 text-xs font-medium capitalize transition-colors",
                  theme === t
                    ? "bg-background text-foreground shadow-card"
                    : "text-muted-foreground/70 hover:text-muted-foreground"
                )}
              >
                {intl.formatMessage(THEME_LABELS[t])}
              </button>
            ))}
          </div>
        </Section>

        <Section title={<FormattedMessage id="mobile.more.workspace" defaultMessage="Workspace" />}>
          <button
            type="button"
            onClick={() => setFilesOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg border border-border/40 bg-muted/10 px-4 py-3 text-left hover:bg-muted/30"
          >
            <FolderTree className="size-4 text-muted-foreground/70" />
            <span className="text-sm text-foreground/85">
              <FormattedMessage id="mobile.files.title" defaultMessage="Files" />
            </span>
          </button>
        </Section>

        <Section title={<FormattedMessage id="mobile.more.automation" defaultMessage="Automation" />}>
          <button
            type="button"
            onClick={() => setCronjobOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg border border-border/40 bg-muted/10 px-4 py-3 text-left hover:bg-muted/30"
          >
            <CalendarClock className="size-4 text-muted-foreground/70" />
            <span className="text-sm text-foreground/85">
              <FormattedMessage id="mobile.cron.title" defaultMessage="Schedules" />
            </span>
          </button>
        </Section>

        <Section title={<FormattedMessage id="mobile.more.settings" defaultMessage="Settings" />}>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg border border-border/40 bg-muted/10 px-4 py-3 text-left hover:bg-muted/30"
          >
            <Settings className="size-4 text-muted-foreground/70" />
            <span className="text-sm text-foreground/85">
              <FormattedMessage id="mobile.more.openSettings" defaultMessage="Open settings" />
            </span>
          </button>
        </Section>

        {/*
          The privacy policy states analytics can be turned off; this is what
          makes that true. Takes effect immediately — opting out also resets the
          stored anonymous id, and a later opt-in starts a fresh one.
        */}
        <Section title={<FormattedMessage id="mobile.more.privacy" defaultMessage="Privacy" />}>
          <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-muted/10 px-4 py-3">
            <BarChart3 className="size-4 shrink-0 text-muted-foreground/70" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground/85">
                <FormattedMessage id="mobile.more.analytics" defaultMessage="Share usage analytics" />
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                <FormattedMessage
                  id="mobile.more.analytics.help"
                  defaultMessage="Anonymous usage and crash data. Never your code, messages or files."
                />
              </p>
            </div>
            <Switch
              checked={analyticsOn}
              onCheckedChange={(on) => {
                setAnalyticsOn(on)
                setAnalyticsOptedOut(!on)
              }}
            />
          </div>
        </Section>

        {/*
          Account deletion has to be reachable from inside the app (App Store
          Guideline 5.1.1(v)). Kept last and in destructive styling so it reads
          as the end of the list rather than as an ordinary setting.
        */}
        {__APP_TARGET__ === "web" && (
          <Section title={<FormattedMessage id="mobile.more.account" defaultMessage="Account" />}>
            <div className="space-y-2 rounded-lg border border-border/40 bg-muted/10 p-4">
              {confirmDelete ? (
                <>
                  <p className="text-sm font-medium text-foreground/85">
                    <FormattedMessage
                      id="mobile.more.deleteAccount.confirmTitle"
                      defaultMessage="Delete your account?"
                    />
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <FormattedMessage
                      id="mobile.more.deleteAccount.confirmBody"
                      defaultMessage="This permanently removes your account, unpairs every machine, and cannot be undone. Files and projects on your machines are not touched."
                    />
                  </p>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 text-xs"
                      disabled={deleting}
                      onClick={() => setConfirmDelete(false)}
                    >
                      <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 gap-1.5 text-xs"
                      disabled={deleting}
                      onClick={() => void runDeleteAccount()}
                    >
                      {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      <FormattedMessage
                        id="mobile.more.deleteAccount.confirmAction"
                        defaultMessage="Delete account"
                      />
                    </Button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="flex w-full items-center gap-3 text-left"
                >
                  <Trash2 className="size-4 text-destructive/80" />
                  <span className="text-sm text-destructive">
                    <FormattedMessage id="mobile.more.deleteAccount" defaultMessage="Delete account" />
                  </span>
                </button>
              )}
            </div>
          </Section>
        )}
      </div>

      {settingsOpen &&
        createPortal(
          <div className="fixed inset-0 z-50 bg-background">
            <SettingsPage onBack={() => setSettingsOpen(false)} />
          </div>,
          document.body
        )}

      {cronjobOpen &&
        createPortal(
          <div className="fixed inset-0 z-50 bg-background">
            <MobileCronjobScreen onBack={() => setCronjobOpen(false)} />
          </div>,
          document.body
        )}

      {filesOpen &&
        createPortal(
          <div className="fixed inset-0 z-50 bg-background">
            <MobileFilesScreen onBack={() => setFilesOpen(false)} />
          </div>,
          document.body
        )}
    </div>
  )
}

function MachineStatusBadge({ loading, node }: { loading: boolean; node: WebNode | null }) {
  const intl = useIntl()
  // node === null after load means the selected machine is no longer in the
  // user's node list (removed/unreachable) — treat it as offline.
  const { label, className } = loading
    ? { label: intl.formatMessage({ id: "mobile.more.status.checking", defaultMessage: "Checking…" }), className: "bg-muted text-muted-foreground" }
    : node?.revoked
      ? { label: intl.formatMessage({ id: "mobile.more.status.revoked", defaultMessage: "Revoked" }), className: "bg-red-500/10 text-red-500" }
      : node?.online
        ? { label: intl.formatMessage({ id: "mobile.more.status.online", defaultMessage: "Online" }), className: "bg-emerald-500/10 text-emerald-500" }
        : { label: intl.formatMessage({ id: "mobile.more.status.offline", defaultMessage: "Offline" }), className: "bg-amber-500/10 text-amber-500" }
  return (
    <span
      className={cn(
        "ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        className,
      )}
    >
      {label}
    </span>
  )
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">
        {title}
      </h2>
      {children}
    </section>
  )
}
