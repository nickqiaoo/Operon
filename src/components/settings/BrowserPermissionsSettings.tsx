import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"

type Approvals = Awaited<ReturnType<typeof api.browserUseGetApprovals>>
type Resource = "origins" | "downloads" | "uploads"
type Mode = "ask" | "never_ask"

const sections: { resource: Resource; title: string; description: string }[] = [
    { resource: "origins", title: "Website access", description: "Choose which sites agents may open." },
    { resource: "downloads", title: "Downloads", description: "Control file downloads from each site." },
    { resource: "uploads", title: "Uploads", description: "Control file uploads to each site." },
]

function RuleSection({
    resource, title, description, allowed, denied, mode, busy, onMode, onSetRule, onRevoke,
}: {
    resource: Resource
    title: string
    description: string
    allowed: string[]
    denied: string[]
    mode: Mode
    busy: boolean
    onMode: (resource: Resource, mode: Mode) => void
    onSetRule: (resource: Resource, origin: string, decision: "allow" | "deny") => Promise<boolean>
    onRevoke: (resource: Resource, origin: string) => void
}) {
    const [origin, setOrigin] = useState("")
    const addRule = async (decision: "allow" | "deny") => {
        if (await onSetRule(resource, origin, decision)) setOrigin("")
    }

    return (
        <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-semibold">{title}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{description}</p>
                </div>
                <Select value={mode} onValueChange={(value) => onMode(resource, value === "never_ask" ? "never_ask" : "ask")} disabled={busy}>
                    <SelectTrigger size="sm" aria-label={`${title} default permission`} className="min-w-44 bg-background/70">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="ask">Ask when needed</SelectItem>
                        <SelectItem value="never_ask">Allow without asking</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            <div className="flex flex-wrap gap-2">
                <Input
                    type="url"
                    value={origin}
                    onChange={(event) => setOrigin(event.target.value)}
                    placeholder="https://example.com"
                    aria-label={`${title} site URL`}
                    className="min-w-48 flex-1 bg-background/70"
                />
                <Button size="sm" variant="outline" className="h-9 gap-1.5 border-border/50" disabled={busy || !origin.trim()} onClick={() => void addRule("allow")}>
                    <Plus className="size-3.5" /> Allow
                </Button>
                <Button size="sm" variant="outline" className="h-9 gap-1.5 border-border/50" disabled={busy || !origin.trim()} onClick={() => void addRule("deny")}>
                    Block
                </Button>
            </div>

            {allowed.length + denied.length > 0 && (
                <ul className="space-y-1.5">
                    {[...allowed.map((site) => ({ site, decision: "Allowed" })), ...denied.map((site) => ({ site, decision: "Blocked" }))].map(({ site, decision }) => (
                        <li key={`${decision}:${site}`} className="flex items-center gap-3 rounded-lg border border-border/40 bg-background/60 px-3 py-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={site}>{site}</span>
                            <span className="text-xs text-muted-foreground">{decision}</span>
                            <Button size="icon" variant="ghost" className="size-7 shrink-0" disabled={busy} aria-label={`Remove ${decision.toLowerCase()} rule for ${site}`} onClick={() => onRevoke(resource, site)}>
                                <Trash2 className="size-3.5" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <p className="text-xs text-muted-foreground">Blocked sites always take priority over allowed sites.</p>
        </section>
    )
}

export function BrowserPermissionsSettings() {
    const [data, setData] = useState<Approvals | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            setData(await api.browserUseGetApprovals())
            setError(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void load() }, [load])

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

    if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading…</div>

    return (
        <div className="space-y-5">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="text-sm font-medium">Shared browser permissions</p>
                    <p className="mt-1 text-xs text-muted-foreground">These rules apply to both the built-in browser and Chrome.</p>
                </div>
                <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={() => void load()}><RefreshCw className="size-3.5" />Refresh</Button>
            </div>
            {error && <div role="alert" className="flex items-center gap-2 text-xs text-destructive"><AlertCircle className="size-4" />{error}</div>}

            {data && (
                <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                    <div className="flex items-start gap-3">
                        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                        <div className="flex-1">
                            <h2 className="text-sm font-semibold">Full CDP access</h2>
                            <p className="mt-1 text-xs text-muted-foreground">Allow raw Chrome DevTools Protocol commands in either browser.</p>
                        </div>
                        <Switch checked={data.fullCdpAccess} disabled={busy} onCheckedChange={(enabled) => { void mutate(() => api.browserUseSetFullCdpAccess(enabled)) }} />
                    </div>
                </section>
            )}

            {data && sections.map(({ resource, title, description }) => (
                <RuleSection
                    key={resource}
                    resource={resource}
                    title={title}
                    description={description}
                    allowed={resource === "origins" ? data.allowed : data[resource].allowed}
                    denied={resource === "origins" ? data.denied : data[resource].denied}
                    mode={data.modes[resource]}
                    busy={busy}
                    onMode={(key, mode) => { void mutate(() => api.browserUseSetMode(key, mode)) }}
                    onSetRule={(key, site, decision) => mutate(() => api.browserUseSetRule(key, site, decision))}
                    onRevoke={(key, site) => { void mutate(() => api.browserUseRevokeRule(key, site)) }}
                />
            ))}

            {data && (
                <section className="space-y-4 rounded-xl border border-border/40 bg-muted/10 p-5">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-semibold">Browsing history</h2>
                            <p className="mt-1 text-xs text-muted-foreground">Choose whether agents ask before reading your Chrome history.</p>
                        </div>
                        <Select value={data.modes.history} disabled={busy} onValueChange={(value) => { void mutate(() => api.browserUseSetMode("history", value === "never_ask" ? "never_ask" : "ask")) }}>
                            <SelectTrigger size="sm" aria-label="Browsing history permission" className="min-w-44 bg-background/70"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="ask">Ask when needed</SelectItem>
                                <SelectItem value="never_ask">Allow without asking</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </section>
            )}

            {data && data.rememberedFromConversations > 0 && (
                <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/40 bg-muted/10 p-5">
                    <div>
                        <h2 className="text-sm font-semibold">Saved conversation permissions</h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {data.rememberedFromConversations} conversations have saved site access, upload, or download decisions. These are separate from Full CDP access.
                        </p>
                    </div>
                    <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={() => { void mutate(() => api.browserUseClearRemembered()) }}><Trash2 className="size-3.5" />Clear all</Button>
                </section>
            )}
        </div>
    )
}
