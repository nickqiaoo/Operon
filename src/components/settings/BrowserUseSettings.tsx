import { useCallback, useEffect, useState } from "react"
import { AlertCircle, AppWindow, Globe, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { FormattedMessage } from "react-intl"

/**
 * Browser Use settings — whether agents get the built-in browser at all, and what
 * they may do with it once they have it.
 *
 * The master switch is the only control here that changes what an agent *sees*: off
 * means neither the skill nor the node_repl MCP is injected. Everything below it is
 * about a Browser Use that is already on, so those sections stay hidden while it is
 * off — a "Full CDP access" toggle for a browser no agent can reach is just noise.
 * The approvals themselves survive the round trip; they reappear on re-enable.
 *
 * The approval sections read the very store `nodeRepl.config` writes when an agent asks
 * "may I open X?" (`~/.operon/browser/`, mirroring codex's `~/.codex/browser/`). Revoking
 * here means the agent gets asked again.
 *
 * ## Why so little is shown
 * codex has no settings UI for any of this — approvals are granted purely through the
 * in-conversation prompt (verified: `full_cdp_access_enabled` has read/write sites in
 * the app and no UI anywhere). We deliberately show only what stays useful after the
 * conversation ends:
 *
 * - **Global approvals** — the user picked "allow for all conversations". Durable, and
 *   otherwise impossible to take back short of hand-editing TOML.
 * - **Full CDP access** — a large, permanent permission granted by one click in some
 *   past prompt. Leaving it invisible *and* irreversible is a real gap in codex, not a
 *   design to copy.
 *
 * Per-conversation approvals are intentionally **not listed**: they die with their
 * conversation, and "conversation 019f5a22 approved example.com" tells the user nothing
 * actionable. They get a count and one Clear button.
 */

type Approvals = Awaited<ReturnType<typeof api.browserUseGetApprovals>>

export function BrowserUseSettings() {
    const [data, setData] = useState<Approvals | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            setData(await api.browserUseGetApprovals())
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const withBusy = async (key: string, fn: () => Promise<unknown>) => {
        setBusy(key)
        try {
            await fn()
            await load()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(null)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                <FormattedMessage id="settings.browserUse.loading" defaultMessage="Loading…" />
            </div>
        )
    }

    const allowed = data?.allowed ?? []
    const denied = data?.denied ?? []
    const remembered = data?.rememberedFromConversations ?? 0
    const enabled = data?.enabled ?? false

    return (
        <div className="space-y-6">
            {error && (
                <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {error}
                </div>
            )}

            {/* —— Master switch —— */}
            <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                <div className="flex items-start gap-3">
                    <AppWindow className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                        <h2 className="text-sm font-semibold mb-1">
                            <FormattedMessage id="settings.browserUse.enabled.title" defaultMessage="Browser Use" />
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            <FormattedMessage
                                id="settings.browserUse.enabled.desc"
                                defaultMessage="Let agents drive the built-in browser — open pages, click, type and read what they see. Turning this on installs the Browser skill for your agents; turning it off removes it again."
                            />
                        </p>
                    </div>
                    <Switch
                        checked={enabled}
                        disabled={busy === "enabled"}
                        onCheckedChange={(v) => void withBusy("enabled", () => api.browserUseSetEnabled(v))}
                    />
                </div>
                {!enabled && (
                    <div className="rounded-lg border border-dashed border-border/50 p-6 text-center text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.browserUse.enabled.off"
                            defaultMessage="Agents cannot see the browser. Sites you approved before are kept and apply again once you turn this back on."
                        />
                    </div>
                )}
            </section>

            {enabled && (
                <>
            {/* —— Approved sites (global only) —— */}
            <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                <div className="flex items-start gap-3">
                    <Globe className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                        <h2 className="text-sm font-semibold mb-1">
                            <FormattedMessage id="settings.browserUse.origins.title" defaultMessage="Approved sites" />
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            <FormattedMessage
                                id="settings.browserUse.origins.desc"
                                defaultMessage="Sites you allowed agents to open in every conversation. Revoke one and the agent has to ask again next time it goes there."
                            />
                        </p>
                    </div>
                    <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => void load()}>
                        <RefreshCw className="h-3.5 w-3.5" />
                        <FormattedMessage id="settings.browserUse.refresh" defaultMessage="Refresh" />
                    </Button>
                </div>

                {allowed.length === 0 && denied.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border/50 p-6 text-center text-xs text-muted-foreground">
                        <FormattedMessage
                            id="settings.browserUse.origins.empty"
                            defaultMessage="No sites approved for all conversations. Agents ask before opening one."
                        />
                    </div>
                ) : (
                    <ul className="space-y-1">
                        {allowed.map((origin) => (
                            <li
                                key={origin}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2"
                            >
                                <span className="text-xs font-mono truncate">{origin}</span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 gap-1.5 text-xs shrink-0"
                                    disabled={busy === origin}
                                    onClick={() => void withBusy(origin, () => api.browserUseRevokeOrigin(origin))}
                                >
                                    {busy === origin && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                    <FormattedMessage id="settings.browserUse.revoke" defaultMessage="Revoke" />
                                </Button>
                            </li>
                        ))}
                        {denied.map((origin) => (
                            <li
                                key={`d-${origin}`}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-background/40 px-3 py-2"
                            >
                                <span className="text-xs font-mono truncate text-muted-foreground line-through">
                                    {origin}
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 gap-1.5 text-xs shrink-0"
                                    disabled={busy === origin}
                                    onClick={() => void withBusy(origin, () => api.browserUseRevokeOrigin(origin))}
                                >
                                    <FormattedMessage id="settings.browserUse.forget" defaultMessage="Forget" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}

                {remembered > 0 && (
                    <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-3">
                        <p className="text-xs text-muted-foreground">
                            <FormattedMessage
                                id="settings.browserUse.remembered"
                                defaultMessage="{count, plural, one {# approval remembered from a past conversation} other {# approvals remembered from past conversations}}"
                                values={{ count: remembered }}
                            />
                        </p>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1.5 text-xs shrink-0"
                            disabled={busy === "clear"}
                            onClick={() => void withBusy("clear", () => api.browserUseClearRemembered())}
                        >
                            {busy === "clear" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                            )}
                            <FormattedMessage id="settings.browserUse.clearRemembered" defaultMessage="Clear all" />
                        </Button>
                    </div>
                )}
            </section>

            {/* —— Full CDP access —— */}
            <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                <div className="flex items-start gap-3">
                    <ShieldCheck className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                        <h2 className="text-sm font-semibold mb-1">
                            <FormattedMessage id="settings.browserUse.fullCdp.title" defaultMessage="Full CDP access" />
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            <FormattedMessage
                                id="settings.browserUse.fullCdp.desc"
                                defaultMessage="Let agents send raw Chrome DevTools Protocol commands, not just the high-level browser actions. Powerful and hard to audit — leave this off unless you need it."
                            />
                        </p>
                    </div>
                    <Switch
                        checked={data?.fullCdpAccess ?? false}
                        disabled={busy === "full-cdp"}
                        onCheckedChange={(v) =>
                            void withBusy("full-cdp", () => api.browserUseSetFullCdpAccess(v))
                        }
                    />
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted-foreground rounded-lg bg-background/40 border border-border/40 p-3">
                    <span>
                        <FormattedMessage id="settings.browserUse.storedAt" defaultMessage="Stored at" />
                    </span>
                    <span className="font-mono truncate">{data?.configPath ?? "~/.operon/browser"}</span>
                </div>
            </section>
                </>
            )}
        </div>
    )
}
