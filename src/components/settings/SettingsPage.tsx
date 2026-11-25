declare const __ENABLE_MEMORY__: boolean
import { FileText, Keyboard, Bell, Bot, CircleHelp, ExternalLink } from "lucide-react"
import { openExternalUrl } from "@/lib/open-external"
import { SpecIcon } from "@/components/icons/SpecIcon"
import { ArrowLeft, Palette, Server, Brain, Plug, Sparkles, Cpu, MessageSquare, MessageCircle, Github, Cloud, Globe, MonitorCog, Puzzle } from "lucide-react"
import { LinearIcon } from "@/components/icons/LinearIcon"
import { ProvidersTab } from "./ProvidersTab"
import { RepoDetail } from "./RepoDetail"
import { McpSettings } from "./McpSettings"
import { AppearanceTab } from "./AppearanceTab"
import { LogsSettings } from "./LogsSettings"
import { EnvSettings } from "./EnvSettings"
import { MemorySettings } from "./MemorySettings"
import { GatewaySettings } from "./GatewaySettings"
import { LinearSettings } from "./LinearSettings"
import { GithubSettings } from "./GithubSettings"
import { CommitMessageSettings } from "./CommitMessageSettings"
import { BrowserSettings } from "./BrowserSettings"
import { ComputerUseSettings } from "./ComputerUseSettings"
import { SaasSettings } from "./SaasSettings"
import { SkillsSettings } from "@/components/skill/SkillsSettings"
import { ExtensionsSettings } from "./ExtensionsSettings"
import { NotificationTab } from "./NotificationTab"
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings"
import { AgentsTab } from "./AgentsTab"
import { agentIdForLegacyTab } from "./agents-registry"
import { Button } from "@/components/ui/button"
import { FormattedMessage } from "react-intl"
import { useProjectStore } from "@/stores/project-store"
import { cn } from "@/lib/utils"
import { useState, useMemo, type ComponentType, type ReactNode } from "react"
import { AssistantSettings } from "./AssistantSettings"
import { SpecSettings } from "./SpecSettings"

interface SettingsPageProps {
    onBack: () => void
    /** Tab to land on when something deep-linked here; defaults to Appearance. */
    initialTab?: SettingsTab
}

type SettingsTab = "appearance" | "notifications" | "logs" | "memory" | "mcp" | "env" | "agents" | "providers" | "gateway" | "linear" | "github" | string

interface SettingsTabDef {
    id: SettingsTab
    label: ReactNode
    icon: ComponentType<{ className?: string }>
}

/**
 * Where a deep link lands: the tab, plus the agent when it names one.
 * `agents:codex` and the pre-merge per-agent ids (`codex`, `code`, `custom`…)
 * both open Agents on that agent; `chrome` is the Browser tab's Chrome surface.
 */
function resolveInitialTab(tab: SettingsTab | undefined): { tab: SettingsTab; agentId?: string } {
    if (tab == null) return { tab: "providers" }
    if (tab === "chrome") return { tab: "browser" }
    if (tab.startsWith("agents:")) return { tab: "agents", agentId: tab.slice("agents:".length) }
    const agentId = agentIdForLegacyTab(tab)
    if (agentId) return { tab: "agents", agentId }
    return { tab }
}

export function SettingsPage({ onBack, initialTab }: SettingsPageProps) {
    const initial = resolveInitialTab(initialTab)
    const [activeTab, setActiveTab] = useState<SettingsTab>(initial.tab)
    // On phones the two panes can't sit side by side, so we drill down:
    // the category list fills the screen, and picking one swaps to its detail
    // pane (the in-pane back button returns to the list). Ignored at md+, where
    // both panes always show. A deep link lands straight on its pane.
    const [mobileDetail, setMobileDetail] = useState(initialTab != null)
    const projects = useProjectStore((s) => s.projects)

    const selectTab = (id: SettingsTab) => {
        setActiveTab(id)
        setMobileDetail(true)
    }

    const tabGroups = useMemo((): { id: string; label: ReactNode; tabs: SettingsTabDef[] }[] => [
        {
            id: "general",
            label: <FormattedMessage id="settings.group.general" defaultMessage="General" />,
            tabs: [
                // Model access first: nothing else works until a provider is set up.
                { id: "providers", label: <FormattedMessage id="settings.tab.providers" defaultMessage="AI Providers" />, icon: Cpu },
                { id: "appearance", label: <FormattedMessage id="settings.tab.appearance" defaultMessage="Appearance" />, icon: Palette },
                { id: "notifications", label: <FormattedMessage id="settings.tab.notifications" defaultMessage="Notifications" />, icon: Bell },
                { id: "shortcuts", label: <FormattedMessage id="settings.tab.shortcuts" defaultMessage="Keyboard shortcuts" />, icon: Keyboard },
            ],
        },
        {
            id: "agents",
            label: <FormattedMessage id="settings.group.agents" defaultMessage="Agents" />,
            tabs: [
                // Every coding agent (Claude Code, Codex, …) lives inside this one tab.
                { id: "agents", label: <FormattedMessage id="settings.tab.agents" defaultMessage="Agents" />, icon: Bot },
                // Operon's own features, not agents you pick — kept out of that list.
                { id: "assistant", label: <FormattedMessage id="settings.tab.assistant" defaultMessage="Assistant" />, icon: MessageCircle },
                { id: "spec", label: <FormattedMessage id="settings.tab.spec" defaultMessage="OperonSpec" />, icon: SpecIcon },
            ],
        },
        {
            id: "capabilities",
            label: <FormattedMessage id="settings.group.capabilities" defaultMessage="Capabilities" />,
            tabs: [
                { id: "mcp", label: <FormattedMessage id="settings.tab.mcp" defaultMessage="MCP" />, icon: Plug },
                { id: "skills", label: <FormattedMessage id="settings.tab.skills" defaultMessage="Skills" />, icon: Sparkles },
                { id: "extensions", label: <FormattedMessage id="settings.tab.extensions" defaultMessage="Extensions" />, icon: Puzzle },
                ...(__ENABLE_MEMORY__ ? [{ id: "memory", label: <FormattedMessage id="settings.tab.memory" defaultMessage="Memory" />, icon: Brain }] : []),
                { id: "env", label: <FormattedMessage id="settings.tab.env" defaultMessage="Env" />, icon: Server },
                // Both browser surfaces share one permission store; Computer Use is separate.
                ...(__APP_TARGET__ === 'web' ? [] : [{ id: "browser", label: <FormattedMessage id="settings.tab.browser" defaultMessage="Browser" />, icon: Globe }]),
                ...(__APP_TARGET__ === 'web' ? [] : [{ id: "computer", label: <FormattedMessage id="settings.tab.computer" defaultMessage="Computer" />, icon: MonitorCog }]),
            ],
        },
        {
            id: "integrations",
            label: <FormattedMessage id="settings.group.integrations" defaultMessage="Integrations" />,
            tabs: [
                { id: "github", label: <FormattedMessage id="settings.tab.github" defaultMessage="GitHub" />, icon: Github },
                { id: "linear", label: <FormattedMessage id="settings.tab.linear" defaultMessage="Linear" />, icon: LinearIcon },
                { id: "gateway", label: <FormattedMessage id="settings.tab.gateway" defaultMessage="Gateway" />, icon: MessageSquare },
                // "Remote" is the desktop-side control panel for THIS feature (loopback
                // OAuth → register node). Meaningless from the web client, which is already remote.
                ...(__APP_TARGET__ === 'web' ? [] : [{ id: "saas", label: <FormattedMessage id="settings.tab.saas" defaultMessage="Remote" />, icon: Cloud }]),
            ],
        },
        {
            id: "diagnostics",
            label: <FormattedMessage id="settings.group.diagnostics" defaultMessage="Diagnostics" />,
            // Logs read the local operon.log via electronAPI — unavailable on the web build.
            tabs: __APP_TARGET__ === 'web' ? [] : [{ id: "logs", label: <FormattedMessage id="settings.tab.logs" defaultMessage="Logs" />, icon: FileText }],
        },
    ].filter((g) => g.tabs.length > 0), [])
    const tabs = useMemo(() => tabGroups.flatMap((g) => g.tabs), [tabGroups])

    const activeProject = activeTab.startsWith("repo:")
        ? projects.find(p => `repo:${p.id}` === activeTab)
        : null

    return (
        <div data-testid="settings-dialog" className="flex h-[100dvh] w-screen bg-background text-foreground overflow-hidden">
            {/* Sidebar — full width on phones (list view), fixed rail at md+ */}
            <div
                className={cn(
                    "flex-col border-r border-border/60 bg-muted/10 md:flex md:w-64 md:flex-shrink-0",
                    mobileDetail ? "hidden" : "flex w-full"
                )}
                style={{ paddingTop: "env(safe-area-inset-top)" }}
            >
                <div className="hidden h-10 drag-region shrink-0 md:block" />
                <div className="p-4 pt-0 flex flex-col gap-2 flex-1 overflow-auto code-scrollbar scroll-fade-y">
                    <Button
                        data-testid="settings-back-button"
                        variant="ghost"
                        className="justify-start gap-2 pl-0 hover:bg-transparent hover:text-foreground/80 text-muted-foreground w-fit no-drag"
                        onClick={onBack}
                    >
                        <ArrowLeft className="h-4 w-4" />
                        <FormattedMessage id="settings.back" defaultMessage="Back to app" />
                    </Button>

                    <div className="space-y-4">
                        {tabGroups.map((group) => (
                            <div key={group.id} className="space-y-0.5">
                                <div className="heading-section px-3 pb-1">{group.label}</div>
                                {group.tabs.map((tab) => (
                                    <button
                                        key={tab.id}
                                        data-testid={`settings-tab-${tab.id}`}
                                        data-active={activeTab === tab.id ? 'true' : undefined}
                                        onClick={() => selectTab(tab.id)}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left",
                                            activeTab === tab.id
                                                ? "bg-row-selected text-foreground"
                                                : "text-muted-foreground hover:bg-row-hover hover:text-foreground"
                                        )}
                                    >
                                        <tab.icon className="h-4 w-4" />
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>

                    {/* Repositories Section */}
                    {projects.length > 0 && (
                        <div className="mt-4">
                            <div className="heading-section px-3 pb-1">
                                <FormattedMessage id="settings.repositories" defaultMessage="Repositories" />
                            </div>
                            <div className="space-y-0.5">
                                {projects.map(project => (
                                    <button
                                        key={project.id}
                                        onClick={() => selectTab(`repo:${project.id}`)}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left group",
                                            activeTab === `repo:${project.id}`
                                                ? "bg-row-selected text-foreground"
                                                : "text-muted-foreground hover:bg-row-hover hover:text-foreground"
                                        )}
                                    >
                                        <span className="truncate flex-1">{project.name}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                {/* Help leaves the app for the docs, so it sits apart from the
                    tabs, pinned under the list rather than scrolled with it. */}
                <div className="shrink-0 border-t border-border/40 px-4 py-2" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
                    <button
                        type="button"
                        data-testid="settings-help-link"
                        onClick={() => openExternalUrl("https://github.com/Nickqiaoo/Operon")}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors text-left text-muted-foreground hover:bg-row-hover hover:text-foreground"
                    >
                        <CircleHelp className="h-4 w-4" />
                        <span className="flex-1">
                            <FormattedMessage id="settings.help" defaultMessage="Help & feedback" />
                        </span>
                        <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                    </button>
                </div>
            </div>

            {/* Main Content — full screen on phones (detail view), flex-1 at md+ */}
            <div
                className={cn(
                    "overflow-auto bg-background code-scrollbar md:block md:flex-1 md:scroll-fade-y",
                    mobileDetail ? "block flex-1" : "hidden"
                )}
            >
                <div className="hidden h-10 drag-region shrink-0 md:block" />
                {/* Mobile back-to-list bar (the sidebar is hidden in detail view) */}
                <div
                    className="sticky top-0 z-10 flex items-center border-b border-border/50 bg-background/95 px-2 py-1.5 backdrop-blur md:hidden"
                    style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.375rem)" }}
                >
                    <Button
                        variant="ghost"
                        size="sm"
                        className="gap-2 pl-2 text-muted-foreground hover:text-foreground"
                        onClick={() => setMobileDetail(false)}
                    >
                        <ArrowLeft className="h-4 w-4" />
                        <FormattedMessage id="settings.tab.title" defaultMessage="Settings" />
                    </Button>
                </div>
                {/* The two master/detail tabs get more room: their list takes 232px off the panel. */}
                <div className={cn(
                    "mx-auto py-6 px-6 lg:px-10",
                    activeTab === "agents" || activeTab === "providers" ? "max-w-5xl" : "max-w-4xl",
                )}>
                    <h1 className="text-3xl font-semibold mb-8">
                        {activeProject ? activeProject.name : tabs.find(t => t.id === activeTab)?.label}
                    </h1>

                    {activeProject ? (
                        <RepoDetail
                            key={activeProject.id}
                            projectId={activeProject.id}
                            onBack={() => {
                                setActiveTab("appearance")
                                setMobileDetail(false)
                            }}
                        />
                    ) : (
                        <>
                            {activeTab === "appearance" && <AppearanceTab />}
                            {activeTab === "notifications" && <NotificationTab />}
                            {activeTab === "shortcuts" && <KeyboardShortcutsSettings />}
                            {activeTab === "logs" && <LogsSettings />}
                            {activeTab === "memory" && <MemorySettings />}
                            {activeTab === "mcp" && <McpSettings />}
                            {activeTab === "env" && <EnvSettings />}
                            {activeTab === "agents" && <AgentsTab initialAgentId={initial.agentId} />}
                            {activeTab === "assistant" && <AssistantSettings />}
                            {activeTab === "spec" && <SpecSettings />}
                            {activeTab === "skills" && <SkillsSettings />}
                            {activeTab === "extensions" && <ExtensionsSettings />}
                            {activeTab === "browser" && <BrowserSettings initialSurface={initialTab === "chrome" ? "chrome" : "built-in"} />}
                            {activeTab === "computer" && <ComputerUseSettings />}
                            {activeTab === "gateway" && <GatewaySettings />}
                            {activeTab === "saas" && <SaasSettings />}
                            {activeTab === "linear" && <LinearSettings />}
                            {activeTab === "github" && (
                                <div className="space-y-6">
                                    <GithubSettings />
                                    <CommitMessageSettings />
                                </div>
                            )}
                            {activeTab === "providers" && <ProvidersTab />}
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
