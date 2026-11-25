import { useMemo, useState, type ReactNode } from "react"
import { FormattedMessage, useIntl } from "react-intl"
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { queryClient } from "@/lib/query-client"
import { settingsKeys, useCliPaths, useCliVersion, type CliPathInfo } from "@/lib/settings-queries"
import { cn } from "@/lib/utils"
import { AGENT_SETTINGS, type AgentSettingsEntry } from "./agents-registry"

/**
 * Settings → Agents: every coding agent in one master/detail tab (list on the
 * left, the picked agent's settings on the right), the same shape as AI Providers.
 * They used to be one Settings tab each, which took a third of the nav.
 */

type AgentStatus = "ready" | "attention" | "missing" | "unknown"

const LAST_AGENT_KEY = "operon.settings.agents.selected"

function readLastAgent(): string | null {
    try {
        return localStorage.getItem(LAST_AGENT_KEY)
    } catch {
        return null
    }
}

function rememberAgent(id: string) {
    try {
        localStorage.setItem(LAST_AGENT_KEY, id)
    } catch {
        // Private window / blocked storage: just don't remember.
    }
}

function agentStatus(agent: AgentSettingsEntry, info: CliPathInfo | undefined): AgentStatus {
    // Runs in-process: nothing to install or find.
    if (!agent.cliAdapterId) return "ready"
    if (!info) return "unknown"
    // An override that no longer resolves needs the user even if auto-detect rescued it.
    if (info.path && info.source !== "manual") return "attention"
    return info.available ? "ready" : "missing"
}

const STATUS_DOT: Record<AgentStatus, string> = {
    ready: "bg-accent-green",
    attention: "bg-accent-warm",
    missing: "bg-muted-foreground/20",
    unknown: "bg-muted-foreground/20",
}

export function AgentsTab({ initialAgentId }: { initialAgentId?: string }) {
    const { data: cliPaths, isLoading } = useCliPaths()
    const [picked, setPicked] = useState<string | null>(() => initialAgentId ?? readLastAgent())
    // Below lg the list and the panel can't sit side by side: show one at a time.
    const [mobileDetail, setMobileDetail] = useState(initialAgentId != null)

    const rows = useMemo(
        () => AGENT_SETTINGS.map((agent) => ({
            agent,
            status: agentStatus(agent, agent.cliAdapterId ? cliPaths?.[agent.cliAdapterId] : undefined),
        })),
        [cliPaths],
    )
    // Installed first: most people have two or three of these, and those are the
    // ones they come here for. Until detection answers, keep the registry order.
    const installed = isLoading ? rows : rows.filter((r) => r.status === "ready" || r.status === "attention")
    const notFound = isLoading ? [] : rows.filter((r) => r.status === "missing")

    const selected =
        rows.find((r) => r.agent.id === picked)
        ?? installed[0]
        ?? rows[0]

    const select = (id: string) => {
        setPicked(id)
        rememberAgent(id)
        setMobileDetail(true)
    }

    return (
        <div className="grid min-h-[520px] gap-4 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-6">
            {/* Left column */}
            <div
                data-testid="settings-agents-list"
                className={cn(
                    "min-h-0 flex-col self-start overflow-hidden lg:border-r lg:border-border/40 lg:pr-4 lg:sticky lg:top-4 lg:flex lg:max-h-[min(640px,70dvh)]",
                    mobileDetail ? "hidden" : "flex",
                )}
            >
                <div className="min-h-0 overflow-y-auto overscroll-contain code-scrollbar">
                    <AgentGroup title={<FormattedMessage id="settings.agents.installed" defaultMessage="Installed" />}>
                        {installed.map(({ agent, status }) => (
                            <AgentItem key={agent.id} agent={agent} status={status} selected={agent.id === selected.agent.id} onClick={() => select(agent.id)} />
                        ))}
                    </AgentGroup>
                    {notFound.length > 0 && (
                        <AgentGroup className="mt-3" title={<FormattedMessage id="settings.agents.notFound" defaultMessage="Not found" />}>
                            {notFound.map(({ agent, status }) => (
                                <AgentItem key={agent.id} agent={agent} status={status} selected={agent.id === selected.agent.id} onClick={() => select(agent.id)} />
                            ))}
                        </AgentGroup>
                    )}
                </div>

            </div>

            {/* Right column */}
            <div className={cn("min-w-0 space-y-6 lg:block", mobileDetail ? "block" : "hidden")}>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 -ml-2 text-xs text-muted-foreground hover:text-foreground lg:hidden"
                    onClick={() => setMobileDetail(false)}
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    <FormattedMessage id="settings.tab.agents" defaultMessage="Agents" />
                </Button>
                <AgentHeader
                    key={selected.agent.id}
                    agent={selected.agent}
                    status={selected.status}
                    info={selected.agent.cliAdapterId ? cliPaths?.[selected.agent.cliAdapterId] : undefined}
                />
                <div key={`body-${selected.agent.id}`} className="space-y-6">
                    {selected.agent.content()}
                </div>
            </div>
        </div>
    )
}

function AgentGroup({ title, className, children }: { title: ReactNode; className?: string; children: ReactNode }) {
    return (
        <div className={className}>
            <p className="heading-section px-2 pb-1.5 pt-1">{title}</p>
            <div className="space-y-0.5">{children}</div>
        </div>
    )
}

function AgentItem({ agent, status, selected, onClick }: {
    agent: AgentSettingsEntry
    status: AgentStatus
    selected: boolean
    onClick: () => void
}) {
    const Icon = agent.icon
    return (
        <button
            type="button"
            data-testid={`settings-agent-${agent.id}`}
            aria-current={selected ? "true" : undefined}
            data-active={selected ? "true" : undefined}
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
                selected
                    ? "bg-row-selected text-foreground"
                    : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
            )}
        >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="flex-1 truncate text-sm font-medium">{agent.label}</span>
            {status === "attention" && <span className="text-xs text-status-warn"><FormattedMessage id="settings.agents.legendAttention" defaultMessage="Needs attention" /></span>}
        </button>
    )
}

/** Name, version and where the binary resolved to — "can I use this?" without scrolling. */
function AgentHeader({ agent, status, info }: { agent: AgentSettingsEntry; status: AgentStatus; info: CliPathInfo | undefined }) {
    const intl = useIntl()
    const Icon = agent.icon
    const adapterId = agent.cliAdapterId
    const { data: version } = useCliVersion(adapterId ?? "", adapterId ? info : undefined)
    const [refreshing, setRefreshing] = useState(false)

    const redetect = async () => {
        setRefreshing(true)
        try {
            // The version probes sit under the same prefix, so they re-run too.
            await queryClient.invalidateQueries({ queryKey: settingsKeys.cliPaths() })
        } finally {
            setRefreshing(false)
        }
    }

    const statusLabel = {
        ready: intl.formatMessage({ id: "settings.agents.legendReady", defaultMessage: "Ready" }),
        attention: intl.formatMessage({ id: "settings.agents.legendAttention", defaultMessage: "Needs attention" }),
        missing: intl.formatMessage({ id: "settings.agents.legendMissing", defaultMessage: "Not installed" }),
        unknown: intl.formatMessage({ id: "settings.agents.detecting", defaultMessage: "Detecting…" }),
    }[status]
    const statusTone = {
        ready: "bg-status-ok/10 text-status-ok",
        attention: "bg-status-warn/10 text-status-warn",
        missing: "bg-muted text-muted-foreground",
        unknown: "bg-muted text-muted-foreground",
    }[status]

    const sourceLabel = info?.source === "manual"
        ? intl.formatMessage({ id: "settings.cli.manual", defaultMessage: "Manual override" })
        : intl.formatMessage({ id: "settings.cli.auto", defaultMessage: "Auto-detected" })

    let detail: ReactNode
    if (!adapterId) {
        detail = <FormattedMessage id="settings.agents.builtIn" defaultMessage="Built in — runs inside Operon, nothing to install." />
    } else if (info?.available && info.resolvedPath) {
        detail = (
            <>
                <span className="font-mono">{info.resolvedPath}</span>
                <span className="text-muted-foreground/60"> · {sourceLabel}</span>
            </>
        )
    } else if (info) {
        detail = (
            <FormattedMessage
                id="settings.agents.notFoundDetail"
                defaultMessage="No {command} binary on your PATH. Install it, then re-detect — or set a path below."
                values={{ command: <span className="font-mono">{info.command || agent.label}</span> }}
            />
        )
    }

    return (
        <div data-testid="settings-agent-header" className="flex items-start gap-4">
            <div className="flex h-7 shrink-0 items-center">
                <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold">{agent.label}</h2>
                    {version?.version && (
                        <span className="font-mono text-xs text-muted-foreground">v{version.version}</span>
                    )}
                    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", statusTone)}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])} />
                        {statusLabel}
                    </span>
                </div>
                {detail && <div className="mt-1 break-all text-xs text-muted-foreground">{detail}</div>}
            </div>
            {adapterId && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 shrink-0 gap-1.5 text-xs"
                            onClick={() => void redetect()}
                            disabled={refreshing}
                        >
                            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            <FormattedMessage id="settings.agents.redetect" defaultMessage="Re-detect" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        <FormattedMessage id="settings.agents.redetectHint" defaultMessage="Look for the CLI on your PATH again" />
                    </TooltipContent>
                </Tooltip>
            )}
        </div>
    )
}
