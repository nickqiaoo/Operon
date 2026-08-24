declare const __ENABLE_MEMORY__: boolean
import { FileJson, FileText, Keyboard, Bell } from "lucide-react"
import { ArrowLeft, Palette, Server, Brain, Plug, Blocks, Cpu, MessageSquare, Github, Cloud, Globe, MonitorCog, Chrome } from "lucide-react"
import { LinearIcon } from "@/components/icons/LinearIcon"
import { ProvidersTab } from "./ProvidersTab"
import { RepoDetail } from "./RepoDetail"
import { McpSettings } from "./McpSettings"
import { AppearanceTab } from "./AppearanceTab"
import { LogsSettings } from "./LogsSettings"
import { EnvSettings } from "./EnvSettings"
import { MemorySettings } from "./MemorySettings"
import { ConfigEditor } from "./ConfigEditor"
import { CliPathSetting } from "./CliPathSetting"
import { GatewaySettings } from "./GatewaySettings"
import { LinearSettings } from "./LinearSettings"
import { GithubSettings } from "./GithubSettings"
import { CommitMessageSettings } from "./CommitMessageSettings"
import { BrowserUseSettings } from "./BrowserUseSettings"
import { ChromeUseSettings } from "./ChromeUseSettings"
import { ComputerUseSettings } from "./ComputerUseSettings"
import { SaasSettings } from "./SaasSettings"
import { PluginsSettings } from "./PluginsSettings"
import { NotificationTab } from "./NotificationTab"
import { ClaudeCodeIcon, CodexIcon, OpenCodeIcon, KimiIcon, GrokIcon, CopilotIcon, OperonIcon } from "./ProviderIcons"
import { Button } from "@/components/ui/button"
import { FormattedMessage } from "react-intl"
import { useProjectStore } from "@/stores/project-store"
import { cn } from "@/lib/utils"
import { useState, useMemo } from "react"
import type { ConfigFileDefinition } from "./useConfigEditor"

interface SettingsPageProps {
    onBack: () => void
}

type SettingsTab = "appearance" | "notifications" | "logs" | "memory" | "mcp" | "env" | "code" | "codex" | "opencode" | "kimi" | "grok" | "providers" | "gateway" | "linear" | "github" | string

const CLAUDE_CODE_FILES: ConfigFileDefinition[] = [
    { id: "settings", label: <FormattedMessage id="settings.config.labelSettings" defaultMessage="Settings" />, filename: "settings.json", icon: FileJson, validation: "json", placeholder: "{}", description: <FormattedMessage id="settings.config.claudeSettingsDesc" defaultMessage="Global Claude Code settings" /> },
    { id: "claude-md", label: "CLAUDE.md", filename: "CLAUDE.md", icon: FileText, validation: "none", placeholder: "# Custom instructions for Claude...", description: <FormattedMessage id="settings.config.customInstructionsAll" defaultMessage="Custom instructions for all projects" /> },
    { id: "keybindings", label: <FormattedMessage id="settings.config.labelKeybindings" defaultMessage="Keybindings" />, filename: "keybindings.json", icon: Keyboard, validation: "json", placeholder: "{}", description: <FormattedMessage id="settings.config.keybindingsDesc" defaultMessage="Custom keyboard shortcuts" /> },
]

const CODEX_FILES: ConfigFileDefinition[] = [
    { id: "config", label: <FormattedMessage id="settings.config.labelConfig" defaultMessage="Config" />, filename: "config.toml", icon: FileJson, validation: "toml", placeholder: "{}", description: <FormattedMessage id="settings.config.codexSettingsDesc" defaultMessage="Global Codex settings" /> },
    { id: "instructions", label: <FormattedMessage id="settings.config.labelInstructions" defaultMessage="Instructions" />, filename: "instructions.md", icon: FileText, validation: "none", placeholder: "# Custom instructions for Codex...", description: <FormattedMessage id="settings.config.customInstructionsAll" defaultMessage="Custom instructions for all projects" /> },
]

const OPENCODE_FILES: ConfigFileDefinition[] = [
    { id: "config", label: <FormattedMessage id="settings.config.labelConfig" defaultMessage="Config" />, filename: "opencode.json", icon: FileJson, validation: "json", placeholder: "{}", description: <FormattedMessage id="settings.config.opencodeSettingsDesc" defaultMessage="Global OpenCode settings" /> },
    { id: "agents", label: "AGENTS.md", filename: "AGENTS.md", icon: FileText, validation: "none", placeholder: "# Custom instructions for OpenCode...", description: <FormattedMessage id="settings.config.customInstructionsAll" defaultMessage="Custom instructions for all projects" /> },
]

const KIMI_FILES: ConfigFileDefinition[] = [
    { id: "config", label: <FormattedMessage id="settings.config.labelConfig" defaultMessage="Config" />, filename: "config.toml", icon: FileJson, validation: "toml", placeholder: "", description: <FormattedMessage id="settings.config.kimiSettingsDesc" defaultMessage="Global Kimi Code settings" /> },
]

const GROK_FILES: ConfigFileDefinition[] = [
    { id: "config", label: <FormattedMessage id="settings.config.labelConfig" defaultMessage="Config" />, filename: "config.toml", icon: FileJson, validation: "toml", placeholder: "", description: <FormattedMessage id="settings.config.grokSettingsDesc" defaultMessage="Global Grok Build settings" /> },
]

const OPERON_FILES: ConfigFileDefinition[] = [
    { id: "config", label: <FormattedMessage id="settings.config.labelConfig" defaultMessage="Config" />, filename: "config.toml", icon: FileJson, validation: "toml", placeholder: "", description: <FormattedMessage id="settings.config.operonSettingsDesc" defaultMessage="Global Operon settings — permission rules, plugin marketplaces, loop control" /> },
]

export function SettingsPage({ onBack }: SettingsPageProps) {
    const [activeTab, setActiveTab] = useState<SettingsTab>("appearance")
    // On phones the two panes can't sit side by side, so we drill down:
    // the category list fills the screen, and picking one swaps to its detail
    // pane (the in-pane back button returns to the list). Ignored at md+, where
    // both panes always show.
    const [mobileDetail, setMobileDetail] = useState(false)
    const projects = useProjectStore((s) => s.projects)

    const selectTab = (id: SettingsTab) => {
        setActiveTab(id)
        setMobileDetail(true)
    }

    const tabs = useMemo(() => [
        { id: "appearance", label: <FormattedMessage id="settings.tab.appearance" defaultMessage="Appearance" />, icon: Palette },
        { id: "notifications", label: <FormattedMessage id="settings.tab.notifications" defaultMessage="Notifications" />, icon: Bell },
        // Logs read the local operon.log via electronAPI — unavailable on the web build.
        ...(__APP_TARGET__ === 'web' ? [] : [{ id: "logs", label: <FormattedMessage id="settings.tab.logs" defaultMessage="Logs" />, icon: FileText }]),
        ...(__ENABLE_MEMORY__ ? [{ id: "memory" as const, label: <FormattedMessage id="settings.tab.memory" defaultMessage="Memory" />, icon: Brain }] : []),
        { id: "mcp", label: <FormattedMessage id="settings.tab.mcp" defaultMessage="MCP" />, icon: Plug },
        { id: "env", label: <FormattedMessage id="settings.tab.env" defaultMessage="Env" />, icon: Server },
        { id: "code", label: <FormattedMessage id="settings.tab.claudeCode" defaultMessage="Claude Code" />, icon: ClaudeCodeIcon },
        { id: "codex", label: <FormattedMessage id="settings.tab.codex" defaultMessage="Codex" />, icon: CodexIcon },
        { id: "opencode", label: <FormattedMessage id="settings.tab.opencode" defaultMessage="OpenCode" />, icon: OpenCodeIcon },
        { id: "kimi", label: <FormattedMessage id="settings.tab.kimi" defaultMessage="Kimi Code" />, icon: KimiIcon },
        { id: "grok", label: <FormattedMessage id="settings.tab.grok" defaultMessage="Grok" />, icon: GrokIcon },
        { id: "copilot", label: <FormattedMessage id="settings.tab.copilot" defaultMessage="Copilot" />, icon: CopilotIcon },
        { id: "custom", label: <FormattedMessage id="settings.tab.custom" defaultMessage="Operon" />, icon: OperonIcon },
        // "Remote" is the desktop-side control panel for THIS feature (loopback
        // OAuth → register node). Meaningless from the web client, which is already remote.
        ...(__APP_TARGET__ === 'web' ? [] : [{ id: "saas", label: <FormattedMessage id="settings.tab.saas" defaultMessage="Remote" />, icon: Cloud }]),
        { id: "plugins", label: <FormattedMessage id="settings.tab.plugins" defaultMessage="Plugins" />, icon: Blocks },
        // All three drive local hardware from the desktop app: the in-app browser, the user's
        // own Chrome via a native host, and a native engine on this machine. None means
        // anything from the web client, which is already remote.
        ...(__APP_TARGET__ === 'web' ? [] : [{ id: "browser" as const, label: <FormattedMessage id="settings.tab.browser" defaultMessage="Browser" />, icon: Globe }]),
        ...(__APP_TARGET__ === 'web' ? [] : [{ id: "chrome" as const, label: <FormattedMessage id="settings.tab.chrome" defaultMessage="Chrome" />, icon: Chrome }]),
        ...(__APP_TARGET__ === 'web' ? [] : [{ id: "computer" as const, label: <FormattedMessage id="settings.tab.computer" defaultMessage="Computer" />, icon: MonitorCog }]),
        { id: "gateway", label: <FormattedMessage id="settings.tab.gateway" defaultMessage="Gateway" />, icon: MessageSquare },
        { id: "linear", label: <FormattedMessage id="settings.tab.linear" defaultMessage="Linear" />, icon: LinearIcon },
        { id: "github", label: <FormattedMessage id="settings.tab.github" defaultMessage="GitHub" />, icon: Github },
        { id: "providers", label: <FormattedMessage id="settings.tab.providers" defaultMessage="AI Providers" />, icon: Cpu },
    ], [])

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
                <div className="p-4 pt-0 flex flex-col gap-2 flex-1 overflow-auto code-scrollbar">
                    <Button
                        data-testid="settings-back-button"
                        variant="ghost"
                        className="justify-start gap-2 pl-0 hover:bg-transparent hover:text-foreground/80 text-muted-foreground w-fit no-drag"
                        onClick={onBack}
                    >
                        <ArrowLeft className="h-4 w-4" />
                        <FormattedMessage id="settings.back" defaultMessage="Back to app" />
                    </Button>

                    <div className="space-y-1">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                data-testid={`settings-tab-${tab.id}`}
                                data-active={activeTab === tab.id ? 'true' : undefined}
                                onClick={() => selectTab(tab.id as SettingsTab)}
                                className={cn(
                                    "w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors text-left",
                                    activeTab === tab.id
                                        ? "bg-muted text-foreground"
                                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                )}
                            >
                                <tab.icon className="h-4 w-4" />
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    {/* Repositories Section */}
                    {projects.length > 0 && (
                        <div className="mt-6">
                            <div className="px-3 py-2 text-xs font-semibold text-muted-foreground/50 uppercase tracking-wider">
                                <FormattedMessage id="settings.repositories" defaultMessage="Repositories" />
                            </div>
                            <div className="space-y-0.5">
                                {projects.map(project => (
                                    <button
                                        key={project.id}
                                        onClick={() => selectTab(`repo:${project.id}`)}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-colors text-left group",
                                            activeTab === `repo:${project.id}`
                                                ? "bg-muted text-foreground"
                                                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                        )}
                                    >
                                        <span className="truncate flex-1">{project.name}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Main Content — full screen on phones (detail view), flex-1 at md+ */}
            <div
                className={cn(
                    "overflow-auto bg-background code-scrollbar md:block md:flex-1",
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
                <div className="mx-auto max-w-4xl py-6 px-6 lg:px-10">
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
                            {activeTab === "logs" && <LogsSettings />}
                            {activeTab === "memory" && <MemorySettings />}
                            {activeTab === "mcp" && <McpSettings />}
                            {activeTab === "env" && <EnvSettings />}
                            {activeTab === "code" && (
                                <div className="space-y-6">
                                    <CliPathSetting
                                        adapterId="claude-code"
                                        label={<FormattedMessage id="settings.cli.pathLabel" defaultMessage="{name} CLI Path" values={{ name: "Claude Code" }} />}
                                        description={<FormattedMessage id="settings.cli.pathDesc" defaultMessage="Automatically detected from your shell PATH. Add an override only when needed." />}
                                        placeholder="/usr/local/bin/claude"
                                    />
                                    <ConfigEditor configDir=".claude" files={CLAUDE_CODE_FILES} />
                                </div>
                            )}
                            {activeTab === "codex" && (
                                <div className="space-y-6">
                                    <CliPathSetting
                                        adapterId="codex"
                                        label={<FormattedMessage id="settings.cli.pathLabel" defaultMessage="{name} CLI Path" values={{ name: "Codex" }} />}
                                        description={<FormattedMessage id="settings.cli.pathDesc" defaultMessage="Automatically detected from your shell PATH. Add an override only when needed." />}
                                        placeholder="/usr/local/bin/codex"
                                    />
                                    <ConfigEditor configDir=".codex" files={CODEX_FILES} />
                                </div>
                            )}
                            {activeTab === "opencode" && (
                                <div className="space-y-6">
                                    <CliPathSetting
                                        adapterId="opencode"
                                        label={<FormattedMessage id="settings.cli.pathLabel" defaultMessage="{name} CLI Path" values={{ name: "OpenCode" }} />}
                                        description={<FormattedMessage id="settings.cli.pathDesc" defaultMessage="Automatically detected from your shell PATH. Add an override only when needed." />}
                                        placeholder="/usr/local/bin/opencode"
                                    />
                                    <ConfigEditor configDir=".config/opencode" files={OPENCODE_FILES} />
                                </div>
                            )}
                            {activeTab === "kimi" && (
                                <div className="space-y-6">
                                    <CliPathSetting
                                        adapterId="kimi"
                                        label={<FormattedMessage id="settings.cli.pathLabel" defaultMessage="{name} CLI Path" values={{ name: "Kimi" }} />}
                                        description={<FormattedMessage id="settings.cli.pathDesc" defaultMessage="Automatically detected from your shell PATH. Add an override only when needed." />}
                                        placeholder="/usr/local/bin/kimi"
                                    />
                                    <ConfigEditor configDir=".kimi" files={KIMI_FILES} />
                                </div>
                            )}
                            {activeTab === "grok" && (
                                <div className="space-y-6">
                                    <CliPathSetting
                                        adapterId="grok"
                                        label={<FormattedMessage id="settings.cli.pathLabel" defaultMessage="{name} CLI Path" values={{ name: "Grok" }} />}
                                        description={<FormattedMessage id="settings.cli.pathDesc" defaultMessage="Automatically detected from your shell PATH. Add an override only when needed." />}
                                        placeholder="/usr/local/bin/grok"
                                    />
                                    <ConfigEditor configDir=".grok" files={GROK_FILES} />
                                </div>
                            )}
                            {activeTab === "copilot" && (
                                <div className="space-y-6">
                                    <CliPathSetting
                                        adapterId="copilot"
                                        label={<FormattedMessage id="settings.cli.pathLabel" defaultMessage="{name} CLI Path" values={{ name: "Copilot" }} />}
                                        description={<FormattedMessage id="settings.cli.copilotPathDesc" defaultMessage="Operon uses the Copilot CLI you installed. Get it with `brew install copilot-cli` or `npm i -g @github/copilot`." />}
                                        placeholder="/opt/homebrew/bin/copilot"
                                    />
                                </div>
                            )}
                            {activeTab === "custom" && (
                                <ConfigEditor configDir=".operon" files={OPERON_FILES} />
                            )}
                            {activeTab === "plugins" && <PluginsSettings />}
                            {activeTab === "browser" && <BrowserUseSettings />}
                            {activeTab === "chrome" && <ChromeUseSettings />}
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
