import { FormattedMessage } from "react-intl"
import { useThemeStore, applyTheme } from "@/stores/theme-store"
import { useTerminalThemeStore } from "@/stores/terminal-theme-store"
import { useLocaleStore, LOCALE_OPTIONS, type LocalePref } from "@/stores/locale-store"
import { darkThemes, lightThemes, getThemeById } from "@/lib/ui-themes"
import {
    lightTerminalThemes,
    darkTerminalThemes,
    type TerminalTheme,
} from "@/lib/terminal-themes"
import { cn } from "@/lib/utils"
import { Palette, SquareTerminal } from "lucide-react"
import { SettingsRow, SettingsSection } from "./SettingsSection"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

// Literal-id labels keyed by enum value — kept as discrete <FormattedMessage>
// nodes so @formatjs/cli can statically extract each id/defaultMessage.
const THEME_LABEL: Record<"light" | "dark" | "system", React.ReactNode> = {
    light: <FormattedMessage id="settings.appearance.theme.light" defaultMessage="Light" />,
    dark: <FormattedMessage id="settings.appearance.theme.dark" defaultMessage="Dark" />,
    system: <FormattedMessage id="settings.appearance.theme.system" defaultMessage="System" />,
}

export function AppearanceTab() {
    const localeOverride = useLocaleStore((s) => s.localeOverride)
    const setLocale = useLocaleStore((s) => s.setLocale)
    const theme = useThemeStore((s) => s.theme)
    const setTheme = useThemeStore((s) => s.setTheme)
    const lightUITheme = useThemeStore((s) => s.lightUITheme)
    const darkUITheme = useThemeStore((s) => s.darkUITheme)
    const setLightUITheme = useThemeStore((s) => s.setLightUITheme)
    const setDarkUITheme = useThemeStore((s) => s.setDarkUITheme)
    const lightTerminalTheme = useTerminalThemeStore((s) => s.lightTheme)
    const darkTerminalTheme = useTerminalThemeStore((s) => s.darkTheme)
    const setLightTerminalTheme = useTerminalThemeStore((s) => s.setLightTheme)
    const setDarkTerminalTheme = useTerminalThemeStore((s) => s.setDarkTheme)

    const handleLightUITheme = (id: string) => {
        setLightUITheme(id)
        // Re-apply if currently in light mode
        applyTheme(theme)
    }

    const handleDarkUITheme = (id: string) => {
        setDarkUITheme(id)
        // Re-apply if currently in dark mode
        applyTheme(theme)
    }

    const lightPreset = getThemeById(lightUITheme)
    const darkPreset = getThemeById(darkUITheme)

    return (
        <div className="space-y-4">
            <SettingsSection
                icon={Palette}
                title={<FormattedMessage id="settings.appearance.section.interface" defaultMessage="Interface" />}
                description={<FormattedMessage id="settings.appearance.section.interfaceDesc" defaultMessage="Language, color mode and the theme used in each mode." />}
            >
                <div>
                    <SettingsRow
                        title={<FormattedMessage id="settings.appearance.language.title" defaultMessage="Language" />}
                        description={<FormattedMessage id="settings.appearance.language.desc" defaultMessage="Choose your interface language" />}
                        control={
                            <SegmentedControl>
                                {LOCALE_OPTIONS.map((opt) => (
                                    <SegmentedButton
                                        key={opt.id}
                                        testId={`settings-appearance-locale-${opt.id}`}
                                        active={localeOverride === opt.id}
                                        onClick={() => setLocale(opt.id as LocalePref)}
                                    >
                                        {opt.id === "system" ? THEME_LABEL.system : opt.label}
                                    </SegmentedButton>
                                ))}
                            </SegmentedControl>
                        }
                    />
                    <SettingsRow
                        title={<FormattedMessage id="settings.appearance.theme.title" defaultMessage="Theme" />}
                        description={<FormattedMessage id="settings.appearance.theme.desc" defaultMessage="Select your interface color theme" />}
                        control={
                            <SegmentedControl>
                                {(["system", "light", "dark"] as const).map((mode) => (
                                    <SegmentedButton
                                        key={mode}
                                        testId={`settings-appearance-theme-${mode}`}
                                        active={theme === mode}
                                        onClick={() => setTheme(mode)}
                                    >
                                        {THEME_LABEL[mode]}
                                    </SegmentedButton>
                                ))}
                            </SegmentedControl>
                        }
                    />
                    <SettingsRow
                        title={<FormattedMessage id="settings.appearance.lightPreset.title" defaultMessage="Light Theme Preset" />}
                        description={<FormattedMessage id="settings.appearance.lightPreset.desc" defaultMessage="Color scheme for light mode" />}
                        control={
                            <ThemeDropdown
                                themes={lightThemes}
                                value={lightUITheme}
                                onChange={handleLightUITheme}
                                selectedName={lightPreset?.name ?? 'Default'}
                                selectedPreview={lightPreset?.preview ?? '#6358DC'}
                            />
                        }
                    />
                    <SettingsRow
                        title={<FormattedMessage id="settings.appearance.darkPreset.title" defaultMessage="Dark Theme Preset" />}
                        description={<FormattedMessage id="settings.appearance.darkPreset.desc" defaultMessage="Color scheme for dark mode" />}
                        control={
                            <ThemeDropdown
                                themes={darkThemes}
                                value={darkUITheme}
                                onChange={handleDarkUITheme}
                                selectedName={darkPreset?.name ?? 'Default'}
                                selectedPreview={darkPreset?.preview ?? '#8B7DF0'}
                            />
                        }
                    />
                </div>
            </SettingsSection>

            <SettingsSection
                icon={SquareTerminal}
                title={<FormattedMessage id="settings.appearance.section.terminal" defaultMessage="Terminal" />}
                description={<FormattedMessage id="settings.appearance.section.terminalDesc" defaultMessage="Colors for the embedded terminal." />}
            >
                <div>
                    <SettingsRow
                        title={<FormattedMessage id="settings.appearance.lightTerminal.title" defaultMessage="Light Mode Terminal Theme" />}
                        description={<FormattedMessage id="settings.appearance.lightTerminal.desc" defaultMessage="Color scheme for the embedded terminal in light mode" />}
                        control={<TerminalThemeDropdown themes={lightTerminalThemes} value={lightTerminalTheme} onChange={setLightTerminalTheme} />}
                    />
                    <SettingsRow
                        title={<FormattedMessage id="settings.appearance.darkTerminal.title" defaultMessage="Dark Mode Terminal Theme" />}
                        description={<FormattedMessage id="settings.appearance.darkTerminal.desc" defaultMessage="Color scheme for the embedded terminal in dark mode" />}
                        control={<TerminalThemeDropdown themes={darkTerminalThemes} value={darkTerminalTheme} onChange={setDarkTerminalTheme} />}
                    />
                </div>
            </SettingsSection>
        </div>
    )
}

// ── Segmented control (language / theme) ──

function SegmentedControl({ children }: { children: React.ReactNode }) {
    return <div className="flex items-center rounded-lg border border-border/50 bg-muted/30 p-1">{children}</div>
}

function SegmentedButton({ testId, active, onClick, children }: { testId: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            data-testid={testId}
            data-active={active ? 'true' : undefined}
            onClick={onClick}
            className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                active
                    ? "bg-background text-foreground shadow-card ring-1 ring-border/50"
                    : "text-muted-foreground hover:text-foreground"
            )}
        >
            {children}
        </button>
    )
}

// ── Theme dropdown ──

interface ThemeDropdownProps {
    themes: { id: string; name: string; preview: string }[]
    value: string
    onChange: (id: string) => void
    selectedName: string
    selectedPreview: string
}

function ThemeDropdown({ themes, value, onChange, selectedName, selectedPreview }: ThemeDropdownProps) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger aria-label="UI theme preset" className="min-w-[200px] bg-muted/30 shadow-none">
                <SelectValue>
                    <ThemeSwatch preview={selectedPreview} />
                    <span>{selectedName}</span>
                </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="end" className="max-h-80 min-w-[200px]">
                {themes.map((theme) => (
                    <SelectItem key={theme.id} value={theme.id} textValue={theme.name}>
                        <ThemeSwatch preview={theme.preview} />{theme.name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

function ThemeSwatch({ preview }: { preview: string }) {
    return <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white" style={{ backgroundColor: preview }}>Aa</span>
}

// ── Terminal theme dropdown ──

function TerminalSwatch({ theme }: { theme: TerminalTheme }) {
    return (
        <span
            className="flex h-6 w-9 shrink-0 items-center justify-center gap-[3px] rounded border border-border/40"
            style={{ backgroundColor: theme.preview.bg }}
        >
            {theme.preview.dots.map((c, i) => (
                <span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: c }}
                />
            ))}
        </span>
    )
}

interface TerminalThemeDropdownProps {
    themes: TerminalTheme[]
    value: string
    onChange: (id: string) => void
}

function TerminalThemeDropdown({ themes, value, onChange }: TerminalThemeDropdownProps) {
    const selected = themes.find((theme) => theme.id === value) ?? themes[0]
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger aria-label="Terminal theme preset" className="min-w-[200px] bg-muted/30 shadow-none">
                <SelectValue>
                    {selected && <TerminalSwatch theme={selected} />}
                    <span>{selected?.name ?? 'Default'}</span>
                </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="end" className="max-h-80 min-w-[240px]">
                {themes.map((theme) => (
                    <SelectItem key={theme.id} value={theme.id} textValue={theme.name}>
                        <TerminalSwatch theme={theme} />{theme.name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}
