import { useCallback, useEffect, useMemo, useState } from "react"
import {
    AlertCircle,
    AppWindow,
    Ban,
    Check,
    ChevronDown,
    ChevronsUpDown,
    Layers,
    Loader2,
    Lock,
    RefreshCw,
    Trash2,
} from "lucide-react"
import { defineMessages, FormattedMessage, useIntl, type MessageDescriptor } from "react-intl"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { api, type ComputerUseAppRef, type ComputerUseCapability } from "@/lib/api"
import { cn } from "@/lib/utils"

type Approvals = Awaited<ReturnType<typeof api.computerUseGetApprovals>>
type InstalledApp = Awaited<ReturnType<typeof api.computerUseListApps>>["apps"][number]

const capabilityMessages = defineMessages({
    desktopCaptureTitle: { id: "settings.computerUse.capabilities.desktopCapture.title", defaultMessage: "Capture the whole screen" },
    desktopCaptureDesc: {
        id: "settings.computerUse.capabilities.desktopCapture.desc",
        defaultMessage: "Sees every open app, including ones you have not approved.",
    },
    clipboardReadTitle: { id: "settings.computerUse.capabilities.clipboardRead.title", defaultMessage: "Read the clipboard" },
    clipboardReadDesc: {
        id: "settings.computerUse.capabilities.clipboardRead.desc",
        defaultMessage: "The clipboard is shared by every app and may hold passwords or other secrets.",
    },
    clipboardWriteTitle: { id: "settings.computerUse.capabilities.clipboardWrite.title", defaultMessage: "Replace the clipboard" },
    clipboardWriteDesc: {
        id: "settings.computerUse.capabilities.clipboardWrite.desc",
        defaultMessage: "Whatever you last copied is lost.",
    },
})

const CAPABILITY_ROWS: Array<{ id: ComputerUseCapability; title: MessageDescriptor; description: MessageDescriptor }> = [
    { id: "desktop-capture", title: capabilityMessages.desktopCaptureTitle, description: capabilityMessages.desktopCaptureDesc },
    { id: "clipboard-read", title: capabilityMessages.clipboardReadTitle, description: capabilityMessages.clipboardReadDesc },
    { id: "clipboard-write", title: capabilityMessages.clipboardWriteTitle, description: capabilityMessages.clipboardWriteDesc },
]

/** Name first, bundle id underneath: the id is what the rule matches on. */
function AppLabel({ app }: { app: ComputerUseAppRef }) {
    return (
        <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{app.name ?? app.bundleId}</div>
            {app.name != null && (
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={app.bundleId}>
                    {app.bundleId}
                </div>
            )}
        </div>
    )
}

/** Searchable, because a Mac easily has a hundred installed apps. */
function AppPicker({
    apps,
    value,
    onChange,
    disabled,
}: {
    apps: InstalledApp[]
    value: InstalledApp | null
    onChange: (app: InstalledApp) => void
    disabled: boolean
}) {
    const intl = useIntl()
    const [open, setOpen] = useState(false)
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    disabled={disabled}
                    className="flex h-8 min-w-48 flex-1 items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/70 px-3 text-left text-xs transition-colors hover:bg-secondary-hover disabled:opacity-50 dark:border-border/35"
                >
                    <span className={cn("truncate", value == null && "text-muted-foreground")}>
                        {value?.name ?? intl.formatMessage({ id: "settings.computerUse.apps.pick", defaultMessage: "Choose an app…" })}
                    </span>
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
                <Command>
                    <CommandInput
                        placeholder={intl.formatMessage({ id: "settings.computerUse.apps.search", defaultMessage: "Search apps…" })}
                    />
                    <CommandList>
                        <CommandEmpty>
                            <FormattedMessage id="settings.computerUse.apps.noMatch" defaultMessage="No matching app." />
                        </CommandEmpty>
                        {apps.map((app) => (
                            <CommandItem
                                key={app.bundleId}
                                value={`${app.name} ${app.bundleId}`}
                                onSelect={() => {
                                    onChange(app)
                                    setOpen(false)
                                }}
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-xs">{app.name}</div>
                                    <div className="truncate font-mono text-[11px] text-muted-foreground">{app.bundleId}</div>
                                </div>
                                {value?.bundleId === app.bundleId && <Check className="h-3.5 w-3.5" />}
                            </CommandItem>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    )
}

/**
 * What Computer Use may do without asking, and what it may never do.
 *
 * Mirrors the record the host approval broker answers from: apps and cross-app
 * capabilities approved with "Always allow" in a conversation, apps blocked
 * here (which beat every approval), and the engine's built-in protected list.
 */
export function ComputerUseAppPermissions() {
    const intl = useIntl()
    const [data, setData] = useState<Approvals | null>(null)
    const [installed, setInstalled] = useState<InstalledApp[]>([])
    const [picked, setPicked] = useState<InstalledApp | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            const [approvals, apps] = await Promise.all([api.computerUseGetApprovals(), api.computerUseListApps()])
            setData(approvals)
            setInstalled(apps.apps)
            setError(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const mutate = async (action: () => Promise<unknown>): Promise<boolean> => {
        setBusy(true)
        try {
            await action()
            await load()
            return true
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            return false
        } finally {
            setBusy(false)
        }
    }

    // Protected apps are refused whatever the rule, so offering them would only
    // create a rule that can never take effect.
    const pickable = useMemo(() => {
        const protectedIds = new Set(data?.protectedApps.map((app) => app.bundleId.toLowerCase()) ?? [])
        return installed
            .filter((app) => !protectedIds.has(app.bundleId.toLowerCase()))
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [installed, data])

    const addRule = async (rule: "allow" | "block") => {
        if (picked == null) return
        if (await mutate(() => api.computerUseSetAppRule(picked.bundleId, rule))) setPicked(null)
    }

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <FormattedMessage id="settings.computerUse.loading" defaultMessage="Loading…" />
            </div>
        )
    }

    const rules = data
        ? [
              ...data.blockedApps.map((app) => ({ app, rule: "block" as const })),
              ...data.approvedApps.map((app) => ({ app, rule: "allow" as const })),
          ]
        : []

    return (
        <>
            {error && (
                <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {error}
                </div>
            )}

            {data && (
                <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                    <div className="flex items-start gap-3">
                        <AppWindow className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="flex-1">
                            <h2 className="text-sm font-semibold mb-1">
                                <FormattedMessage id="settings.computerUse.apps.title" defaultMessage="App access" />
                            </h2>
                            <p className="text-xs text-muted-foreground">
                                <FormattedMessage
                                    id="settings.computerUse.apps.desc"
                                    defaultMessage="Agents ask before operating an app. Choosing “Always allow” in a conversation adds the app here; blocked apps are refused without asking."
                                />
                            </p>
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1.5 text-xs"
                            disabled={busy}
                            onClick={() => void load()}
                        >
                            <RefreshCw className="h-3.5 w-3.5" />
                            <FormattedMessage id="settings.computerUse.apps.refresh" defaultMessage="Refresh" />
                        </Button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <AppPicker apps={pickable} value={picked} onChange={setPicked} disabled={busy || pickable.length === 0} />
                        <Button
                            size="sm"
                            variant="secondary"
                            className="h-8 gap-1.5"
                            disabled={busy || picked == null}
                            onClick={() => void addRule("allow")}
                        >
                            <Check className="h-3.5 w-3.5" />
                            <FormattedMessage id="settings.computerUse.apps.allow" defaultMessage="Always allow" />
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            className="h-8 gap-1.5"
                            disabled={busy || picked == null}
                            onClick={() => void addRule("block")}
                        >
                            <Ban className="h-3.5 w-3.5" />
                            <FormattedMessage id="settings.computerUse.apps.block" defaultMessage="Block" />
                        </Button>
                    </div>

                    {rules.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border/50 p-6 text-center text-xs text-muted-foreground">
                            <FormattedMessage
                                id="settings.computerUse.apps.empty"
                                defaultMessage="No saved decisions. Agents will ask before operating each app."
                            />
                        </div>
                    ) : (
                        <ul className="space-y-1.5">
                            {rules.map(({ app, rule }) => (
                                <li
                                    key={`${rule}:${app.bundleId}`}
                                    className="flex items-center gap-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2"
                                >
                                    <AppLabel app={app} />
                                    <span
                                        className={cn(
                                            "shrink-0 text-xs",
                                            rule === "block" ? "text-status-error" : "text-status-ok",
                                        )}
                                    >
                                        {rule === "block" ? (
                                            <FormattedMessage id="settings.computerUse.apps.blocked" defaultMessage="Blocked" />
                                        ) : (
                                            <FormattedMessage id="settings.computerUse.apps.allowed" defaultMessage="Always allowed" />
                                        )}
                                    </span>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="size-7 shrink-0"
                                        disabled={busy}
                                        aria-label={intl.formatMessage(
                                            { id: "settings.computerUse.apps.remove", defaultMessage: "Remove rule for {app}" },
                                            { app: app.name ?? app.bundleId },
                                        )}
                                        onClick={() => void mutate(() => api.computerUseSetAppRule(app.bundleId, null))}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}

                    {data.conversationsWithApprovals > 0 && (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/40 p-3">
                            <p className="text-xs text-muted-foreground">
                                <FormattedMessage
                                    id="settings.computerUse.apps.conversations"
                                    defaultMessage="{count, plural, one {# open conversation has} other {# open conversations have}} apps allowed for that conversation only."
                                    values={{ count: data.conversationsWithApprovals }}
                                />
                            </p>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 gap-1.5 text-xs"
                                disabled={busy}
                                onClick={() => void mutate(() => api.computerUseClearConversationApprovals())}
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                                <FormattedMessage id="settings.computerUse.apps.clearConversations" defaultMessage="Clear" />
                            </Button>
                        </div>
                    )}

                    <Collapsible>
                        <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
                            <Lock className="h-3.5 w-3.5 shrink-0" />
                            <span className="flex-1">
                                <FormattedMessage
                                    id="settings.computerUse.apps.protected"
                                    defaultMessage="{count} apps are always off-limits for safety"
                                    values={{ count: data.protectedApps.length }}
                                />
                            </span>
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                            <p className="mt-2 px-1 text-xs text-muted-foreground">
                                <FormattedMessage
                                    id="settings.computerUse.apps.protectedDesc"
                                    defaultMessage="Password managers, terminals, other agents, macOS security prompts and Operon itself. These cannot be allowed."
                                />
                            </p>
                            <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border/40 bg-background/40 p-3 text-xs text-muted-foreground">
                                {data.protectedApps.map((app) => (
                                    <div key={app.bundleId} className="contents">
                                        <span className="truncate">{app.name ?? "—"}</span>
                                        <span className="truncate font-mono text-[11px]">{app.bundleId}</span>
                                    </div>
                                ))}
                            </div>
                        </CollapsibleContent>
                    </Collapsible>
                </section>
            )}

            {data && (
                <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                    <div className="flex items-start gap-3">
                        <Layers className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="flex-1">
                            <h2 className="text-sm font-semibold mb-1">
                                <FormattedMessage id="settings.computerUse.capabilities.title" defaultMessage="Across all apps" />
                            </h2>
                            <p className="text-xs text-muted-foreground">
                                <FormattedMessage
                                    id="settings.computerUse.capabilities.desc"
                                    defaultMessage="These reach beyond any one app, so approving an app does not cover them. Turn one on to stop being asked."
                                />
                            </p>
                        </div>
                    </div>
                    <div className="space-y-2">
                        {CAPABILITY_ROWS.map((row) => {
                            const approved = data.capabilities.find((c) => c.id === row.id)?.approved ?? false
                            return (
                                <div
                                    key={row.id}
                                    className="flex items-center gap-3 rounded-lg border border-border/40 bg-background/40 p-3"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="text-xs font-medium">
                                            <FormattedMessage {...row.title} />
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {approved ? (
                                                <FormattedMessage id="settings.computerUse.capabilities.always" defaultMessage="Allowed without asking" />
                                            ) : (
                                                <FormattedMessage {...row.description} />
                                            )}
                                        </div>
                                    </div>
                                    <Switch
                                        checked={approved}
                                        disabled={busy}
                                        aria-label={intl.formatMessage(row.title)}
                                        onCheckedChange={(next) => void mutate(() => api.computerUseSetCapabilityApproved(row.id, next))}
                                    />
                                </div>
                            )
                        })}
                    </div>
                </section>
            )}
        </>
    )
}
