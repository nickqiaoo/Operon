import { useState, useEffect, useCallback, useMemo } from "react"
import { Loader2, Brain, Database, Trash2, Search, Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FormattedMessage, useIntl } from "react-intl"
import { api, type MemoryPage, type MemoryType, type MemorySearchResult, type MemoryTimelineEntry } from "@/lib/api"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { EmbeddingSettings } from "./EmbeddingSettings"
import { MemoryMaintenanceSettings } from "./MemoryMaintenanceSettings"

const TYPE_COLORS: Record<MemoryType, string> = {
    user: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    entities: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    events: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    cases: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
}

const TYPE_ORDER: MemoryType[] = [
    "user", "entities", "events", "cases",
]

function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString()
}

export function MemorySettings() {
    const intl = useIntl()
    const [activeMemoryTab, setActiveMemoryTab] = useState<"embedding" | "memory" | "maintenance">("embedding")
    const [pages, setPages] = useState<MemoryPage[]>([])
    const [pagesLoading, setPagesLoading] = useState(false)
    const [filterType, setFilterType] = useState<MemoryType | "">("")
    const [searchQuery, setSearchQuery] = useState("")
    const [searchResults, setSearchResults] = useState<MemorySearchResult[] | null>(null)
    const [searching, setSearching] = useState(false)
    const [deleting, setDeleting] = useState<string | null>(null)
    const [timelines, setTimelines] = useState<Record<string, MemoryTimelineEntry[]>>({})
    const [timelineLoading, setTimelineLoading] = useState<Record<string, boolean>>({})

    const typeLabels = useMemo<Record<MemoryType, string>>(() => ({
        user: intl.formatMessage({ id: "settings.memory.type.user", defaultMessage: "User" }),
        entities: intl.formatMessage({ id: "settings.memory.type.entities", defaultMessage: "Entities" }),
        events: intl.formatMessage({ id: "settings.memory.type.events", defaultMessage: "Events" }),
        cases: intl.formatMessage({ id: "settings.memory.type.cases", defaultMessage: "Cases" }),
    }), [intl])

    const loadPages = useCallback(async (type: MemoryType | "") => {
        setPagesLoading(true)
        try {
            const items = await api.memoryList(type || undefined)
            setPages(items)
        } catch (err) {
            console.error("Failed to load memory pages:", err)
        } finally {
            setPagesLoading(false)
        }
    }, [])

    useEffect(() => {
        if (activeMemoryTab === "memory") {
            loadPages(filterType)
        }
    }, [activeMemoryTab, filterType, loadPages])

    const handleSearch = async () => {
        if (!searchQuery.trim()) {
            setSearchResults(null)
            return
        }
        setSearching(true)
        try {
            const results = await api.memorySearch(searchQuery, filterType ? [filterType] : undefined, 20)
            setSearchResults(results)
        } catch (err) {
            console.error("Failed to search memory:", err)
        } finally {
            setSearching(false)
        }
    }

    const handleDelete = async (type: MemoryType, slug: string) => {
        const key = `${type}/${slug}`
        setDeleting(key)
        try {
            await api.memoryDelete(type, slug)
            setPages(prev => prev.filter(p => !(p.type === type && p.slug === slug)))
            if (searchResults) {
                setSearchResults(prev => prev?.filter(r => !(r.type === type && r.slug === slug)) ?? null)
            }
            setTimelines(prev => {
                const next = { ...prev }
                delete next[key]
                return next
            })
        } catch (err) {
            console.error("Failed to delete page:", err)
        } finally {
            setDeleting(null)
        }
    }

    const loadTimeline = async (type: MemoryType, slug: string) => {
        const key = `${type}/${slug}`
        if (timelines[key] || timelineLoading[key]) return
        setTimelineLoading(prev => ({ ...prev, [key]: true }))
        try {
            const detail = await api.memoryGet(type, slug)
            setTimelines(prev => ({ ...prev, [key]: detail.timeline }))
        } catch (err) {
            console.error("Failed to load timeline:", err)
        } finally {
            setTimelineLoading(prev => {
                const next = { ...prev }
                delete next[key]
                return next
            })
        }
    }

    const memoryTabs = [
        { id: "embedding" as const, label: intl.formatMessage({ id: "settings.memory.tab.embedding", defaultMessage: "Embedding" }), icon: Database },
        { id: "memory" as const, label: intl.formatMessage({ id: "settings.memory.tab.memory", defaultMessage: "Memory" }), icon: Brain },
        { id: "maintenance" as const, label: intl.formatMessage({ id: "settings.memory.tab.maintenance", defaultMessage: "Maintenance" }), icon: Wand2 },
    ]

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-1 p-1 bg-muted/30 rounded-lg border border-border/60 w-fit">
                {memoryTabs.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        onClick={() => setActiveMemoryTab(id)}
                        className={cn(
                            "flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                            activeMemoryTab === id
                                ? "bg-background text-foreground shadow-card ring-1 ring-border/50"
                                : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                    </button>
                ))}
            </div>

            {activeMemoryTab === "embedding" && <EmbeddingSettings />}
            {activeMemoryTab === "maintenance" && <MemoryMaintenanceSettings />}

            {activeMemoryTab === "memory" && (
                <div className="space-y-5">
                    <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => {
                                    setSearchQuery(e.target.value)
                                    if (!e.target.value.trim()) setSearchResults(null)
                                }}
                                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                                className="w-full h-9 pl-9 pr-3 bg-muted/20 rounded-lg border border-border/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                                placeholder={intl.formatMessage({ id: "settings.memory.search.placeholder", defaultMessage: "Hybrid search memory pages..." })}
                            />
                        </div>
                        <Button size="sm" variant="secondary" onClick={handleSearch} disabled={searching} className="gap-1.5">
                            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                            <FormattedMessage id="settings.memory.search.button" defaultMessage="Search" />
                        </Button>
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                            onClick={() => { setFilterType(""); setSearchResults(null) }}
                            className={cn(
                                "px-2.5 py-1 text-xs rounded-md transition-all",
                                !filterType
                                    ? "bg-foreground/10 text-foreground font-medium"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <FormattedMessage id="settings.memory.filter.all" defaultMessage="All" />
                        </button>
                        {TYPE_ORDER.map((key) => (
                            <button
                                key={key}
                                onClick={() => { setFilterType(key); setSearchResults(null) }}
                                className={cn(
                                    "px-2.5 py-1 text-xs rounded-md transition-all",
                                    filterType === key
                                        ? "bg-foreground/10 text-foreground font-medium"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {typeLabels[key]}
                            </button>
                        ))}
                    </div>

                    {pagesLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                    ) : searchResults !== null ? (
                        searchResults.length === 0 ? (
                            <div className="text-sm text-muted-foreground py-12 text-center bg-muted/10 rounded-lg">
                                <FormattedMessage id="settings.memory.noResults" defaultMessage="No matching pages found." />
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div className="text-xs text-muted-foreground mb-2">
                                    <FormattedMessage id="settings.memory.results.count" defaultMessage="{count} results" values={{ count: searchResults.length }} />
                                </div>
                                {searchResults.map((r) => (
                                    <details key={`${r.type}/${r.slug}`} className="group rounded-lg border border-border/50 bg-muted/10 hover:bg-muted/20 transition-colors">
                                        <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className={cn(
                                                        "px-1.5 py-0.5 text-[10px] font-medium rounded",
                                                        TYPE_COLORS[r.type] ?? "bg-muted text-muted-foreground",
                                                    )}>
                                                        {typeLabels[r.type] ?? r.type}
                                                    </span>
                                                    {r.score !== undefined && (
                                                        <span className="text-[10px] text-muted-foreground ml-auto">
                                                            <FormattedMessage id="settings.memory.page.score" defaultMessage="score {score}" values={{ score: r.score.toFixed(3) }} />
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-sm truncate">{r.slug}</div>
                                            </div>
                                        </summary>
                                        <div className="px-4 pb-3 border-t border-border/40 pt-3 space-y-3">
                                            <div>
                                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                                                    <FormattedMessage id="settings.memory.page.truth" defaultMessage="Truth" />
                                                </div>
                                                <MarkdownRenderer content={r.truth} className="text-sm leading-relaxed text-muted-foreground" />
                                            </div>
                                            {r.timeline.length > 0 && (
                                                <div>
                                                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                                                        <FormattedMessage id="settings.memory.page.timeline" defaultMessage="Timeline" />
                                                    </div>
                                                    <ul className="space-y-1">
                                                        {r.timeline.map((t) => (
                                                            <li key={t.id} className={cn(
                                                                "text-sm leading-relaxed",
                                                                t.matched ? "text-foreground" : "text-muted-foreground",
                                                            )}>
                                                                {t.occurred_at != null && <span className="text-[10px] text-muted-foreground mr-2">{formatDate(t.occurred_at)}</span>}
                                                                {t.entry}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                        </div>
                                    </details>
                                ))}
                            </div>
                        )
                    ) : pages.length === 0 ? (
                        <div className="text-sm text-muted-foreground py-12 text-center bg-muted/10 rounded-lg">
                            <FormattedMessage id="settings.memory.noPages" defaultMessage="No memory pages yet. Pages are created via the memory MCP / tools." />
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <div className="text-xs text-muted-foreground mb-2">
                                <FormattedMessage id="settings.memory.pages.count" defaultMessage="{count} pages" values={{ count: pages.length }} />
                            </div>
                            {pages.map((page) => {
                                const key = `${page.type}/${page.slug}`
                                const timeline = timelines[key]
                                const loadingTimeline = timelineLoading[key]
                                return (
                                    <details
                                        key={key}
                                        className="group rounded-lg border border-border/50 bg-muted/10 hover:bg-muted/20 transition-colors"
                                        onToggle={(e) => {
                                            if ((e.currentTarget as HTMLDetailsElement).open) {
                                                loadTimeline(page.type, page.slug)
                                            }
                                        }}
                                    >
                                        <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className={cn(
                                                        "px-1.5 py-0.5 text-[10px] font-medium rounded",
                                                        TYPE_COLORS[page.type] ?? "bg-muted text-muted-foreground",
                                                    )}>
                                                        {typeLabels[page.type] ?? page.type}
                                                    </span>
                                                </div>
                                                <div className="text-sm truncate">{page.slug}</div>
                                                <div className="text-xs text-muted-foreground mt-0.5">
                                                    {formatDate(page.updated_at)}
                                                </div>
                                            </div>
                                            <button
                                                onClick={(e) => {
                                                    e.preventDefault()
                                                    e.stopPropagation()
                                                    handleDelete(page.type, page.slug)
                                                }}
                                                disabled={deleting === key}
                                                className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                                                title={intl.formatMessage({ id: "settings.memory.page.delete", defaultMessage: "Delete page" })}
                                            >
                                                {deleting === key
                                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    : <Trash2 className="h-3.5 w-3.5" />
                                                }
                                            </button>
                                        </summary>
                                        <div className="px-4 pb-3 border-t border-border/40 pt-3 space-y-3">
                                            <div>
                                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                                                    <FormattedMessage id="settings.memory.page.truth" defaultMessage="Truth" />
                                                </div>
                                                <MarkdownRenderer content={page.truth} className="text-sm leading-relaxed text-muted-foreground" />
                                            </div>
                                            <div>
                                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
                                                    <FormattedMessage id="settings.memory.page.timeline" defaultMessage="Timeline" />
                                                </div>
                                                {loadingTimeline ? (
                                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                        <FormattedMessage id="settings.memory.loading" defaultMessage="Loading…" />
                                                    </div>
                                                ) : !timeline ? null : timeline.length === 0 ? (
                                                    <div className="text-xs text-muted-foreground">
                                                        <FormattedMessage id="settings.memory.page.noTimeline" defaultMessage="No timeline entries." />
                                                    </div>
                                                ) : (
                                                    <ul className="space-y-1">
                                                        {timeline.map((t) => (
                                                            <li key={t.id} className="text-sm leading-relaxed text-muted-foreground">
                                                                {t.occurred_at != null && <span className="text-[10px] text-muted-foreground mr-2">{formatDate(t.occurred_at)}</span>}
                                                                {t.entry}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                        </div>
                                    </details>
                                )
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
