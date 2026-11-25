import type { ComponentType, ReactNode } from "react"
import { FileJson, FileText, Keyboard } from "lucide-react"
import { FormattedMessage } from "react-intl"
import { ConfigEditor } from "./ConfigEditor"
import { CliPathSetting } from "./CliPathSetting"
import { CliAutoUpdateSettings } from "./CliAutoUpdateSettings"
import { ClaudeTogglesSettings } from "./ClaudeTogglesSettings"
import { AcpAgentInstaller } from "./AcpAgentInstaller"
import { AntigravityAuthStatus } from "./AntigravityAuthStatus"
import { AutoReviewSettings } from "./AutoReviewSettings"
import { SshEnvironmentSettings } from "./SshEnvironmentSettings"
import { ClaudeCodeIcon, CodexIcon, OpenCodeIcon, KimiIcon, GrokIcon, QoderIcon, CopilotIcon, AntigravityIcon, OperonIcon } from "./ProviderIcons"
import type { ConfigFileDefinition } from "./useConfigEditor"


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

const QODER_FILES: ConfigFileDefinition[] = [
    { id: "settings", label: <FormattedMessage id="settings.config.labelSettings" defaultMessage="Settings" />, filename: "settings.json", icon: FileJson, validation: "json", placeholder: "{}", description: <FormattedMessage id="settings.config.qoderSettingsDesc" defaultMessage="Global Qoder CLI settings" /> },
]

const OPERON_FILES: ConfigFileDefinition[] = [
    { id: "config", label: <FormattedMessage id="settings.config.labelConfig" defaultMessage="Config" />, filename: "config.toml", icon: FileJson, validation: "toml", placeholder: "", description: <FormattedMessage id="settings.config.operonSettingsDesc" defaultMessage="Global Operon settings — permission rules, plugin marketplaces, loop control" /> },
]

/**
 * One coding agent on Settings → Agents. Every agent used to be its own Settings
 * tab with a near-identical block of JSX; they now share one master/detail tab
 * and differ only by this entry.
 */
export interface AgentSettingsEntry {
    /** Selection id, also the deep link `agents:<id>`. */
    id: string
    /** The pre-merge Settings tab id, still accepted as a deep link. */
    legacyTabId: string
    /** Product name — not translated. */
    label: string
    icon: ComponentType<{ className?: string }>
    /**
     * Key in `/cli-paths`. Unset for an agent that runs in-process (Operon),
     * which is always ready and has no binary to find.
     */
    cliAdapterId?: string
    content: () => ReactNode
}

const PATH_DESC = <FormattedMessage id="settings.cli.pathDesc" defaultMessage="Automatically detected from your shell PATH. Add an override only when needed." />

function cliPath(adapterId: string, name: string, placeholder: string, description: ReactNode = PATH_DESC) {
    return (
        <CliPathSetting
            adapterId={adapterId}
            label={<FormattedMessage id="settings.cli.pathLabel" defaultMessage="{name} CLI Path" values={{ name }} />}
            description={description}
            placeholder={placeholder}
        />
    )
}

export const AGENT_SETTINGS: readonly AgentSettingsEntry[] = [
    {
        id: "claude-code", legacyTabId: "code", label: "Claude Code", icon: ClaudeCodeIcon, cliAdapterId: "claude-code",
        content: () => (
            <>
                {cliPath("claude-code", "Claude Code", "/usr/local/bin/claude")}
                <CliAutoUpdateSettings adapterId="claude-code" name="Claude Code" />
                <ClaudeTogglesSettings />
                <ConfigEditor configDir=".claude" files={CLAUDE_CODE_FILES} />
            </>
        ),
    },
    {
        id: "codex", legacyTabId: "codex", label: "Codex", icon: CodexIcon, cliAdapterId: "codex",
        content: () => (
            <>
                {cliPath("codex", "Codex", "/usr/local/bin/codex")}
                <CliAutoUpdateSettings adapterId="codex" name="Codex" />
                <ConfigEditor configDir=".codex" files={CODEX_FILES} />
            </>
        ),
    },
    {
        id: "opencode", legacyTabId: "opencode", label: "OpenCode", icon: OpenCodeIcon, cliAdapterId: "opencode",
        content: () => (
            <>
                {cliPath("opencode", "OpenCode", "/usr/local/bin/opencode")}
                <ConfigEditor configDir=".config/opencode" files={OPENCODE_FILES} />
            </>
        ),
    },
    {
        id: "kimi", legacyTabId: "kimi", label: "Kimi Code", icon: KimiIcon, cliAdapterId: "kimi",
        content: () => (
            <>
                {cliPath("kimi", "Kimi", "/usr/local/bin/kimi")}
                <ConfigEditor configDir=".kimi" files={KIMI_FILES} />
            </>
        ),
    },
    {
        id: "grok", legacyTabId: "grok", label: "Grok", icon: GrokIcon, cliAdapterId: "grok",
        content: () => (
            <>
                {cliPath("grok", "Grok", "/usr/local/bin/grok")}
                <ConfigEditor configDir=".grok" files={GROK_FILES} />
            </>
        ),
    },
    {
        id: "qoder", legacyTabId: "qoder", label: "Qoder", icon: QoderIcon, cliAdapterId: "qoder",
        content: () => (
            <>
                {cliPath("qoder", "Qoder", "~/.local/bin/qodercli")}
                <ConfigEditor configDir=".qoder" files={QODER_FILES} />
            </>
        ),
    },
    {
        id: "copilot", legacyTabId: "copilot", label: "Copilot", icon: CopilotIcon, cliAdapterId: "copilot",
        content: () => cliPath(
            "copilot", "Copilot", "/opt/homebrew/bin/copilot",
            <FormattedMessage id="settings.cli.copilotPathDesc" defaultMessage="Operon uses the Copilot CLI you installed. Get it with `brew install copilot-cli` or `npm i -g @github/copilot`." />,
        ),
    },
    {
        id: "antigravity", legacyTabId: "antigravity", label: "Antigravity", icon: AntigravityIcon, cliAdapterId: "antigravity",
        content: () => (
            <>
                <AcpAgentInstaller agentId="antigravity" />
                <AntigravityAuthStatus />
                <CliPathSetting
                    adapterId="antigravity"
                    label={<FormattedMessage id="settings.cli.antigravityPathLabel" defaultMessage="Antigravity ACP Server Path" />}
                    description={<FormattedMessage id="settings.cli.antigravityPathDesc" defaultMessage="Override only if you installed the server yourself." />}
                    placeholder="~/.operon/acp-agents/antigravity/agy_acp_server.par"
                />
            </>
        ),
    },
    {
        id: "operon", legacyTabId: "custom", label: "Operon", icon: OperonIcon,
        content: () => (
            <>
                <AutoReviewSettings />
                <SshEnvironmentSettings />
                <ConfigEditor configDir=".operon" files={OPERON_FILES} />
            </>
        ),
    },
]

/** `"code"` → `"claude-code"`: old per-agent tab ids still deep-link to their agent. */
export function agentIdForLegacyTab(tab: string): string | undefined {
    return AGENT_SETTINGS.find((a) => a.legacyTabId === tab)?.id
}
