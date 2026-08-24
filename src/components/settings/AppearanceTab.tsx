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
import { Check, ChevronDown } from "lucide-react"
import { useState, useRef, useEffect } from "react"

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
        <div className="space-y-8">
            {/* Language Section */}
            <div className="flex items-center justify-between pb-8 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.appearance.language.title" defaultMessage="Language" /></div>
                    <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.appearance.language.desc" defaultMessage="Choose your interface language" /></div>
                </div>
                <div className="flex items-center p-1 bg-muted/30 rounded-lg border border-border/60">
                    {LOCALE_OPTIONS.map((opt) => (
                        <button
                            key={opt.id}
                            data-testid={`settings-appearance-locale-${opt.id}`}
                            data-active={localeOverride === opt.id ? 'true' : undefined}
                            onClick={() => setLocale(opt.id as LocalePref)}
                            className={cn(
                                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                                localeOverride === opt.id
                                    ? "bg-background text-foreground shadow-card ring-1 ring-border/50"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {opt.id === "system" ? THEME_LABEL.system : opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Theme Section */}
            <div className="flex items-center justify-between pb-8 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.appearance.theme.title" defaultMessage="Theme" /></div>
                    <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.appearance.theme.desc" defaultMessage="Select your interface color theme" /></div>
                </div>
                <div className="flex items-center p-1 bg-muted/30 rounded-lg border border-border/60">
                    {(["light", "dark", "system"] as const).map((mode) => (
                        <button
                            key={mode}
                            data-testid={`settings-appearance-theme-${mode}`}
                            data-active={theme === mode ? 'true' : undefined}
                            onClick={() => setTheme(mode)}
                            className={cn(
                                "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                                theme === mode
                                    ? "bg-background text-foreground shadow-card ring-1 ring-border/50"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {THEME_LABEL[mode]}
                        </button>
                    ))}
                </div>
            </div>

            {/* Light UI Theme */}
            <div className="flex items-center justify-between pb-8 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.appearance.lightPreset.title" defaultMessage="Light Theme Preset" /></div>
                    <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.appearance.lightPreset.desc" defaultMessage="Color scheme for light mode" /></div>
                </div>
                <ThemeDropdown
                    themes={lightThemes}
                    value={lightUITheme}
                    onChange={handleLightUITheme}
                    selectedName={lightPreset?.name ?? 'Default'}
                    selectedPreview={lightPreset?.preview ?? '#6358DC'}
                />
            </div>

            {/* Dark UI Theme */}
            <div className="flex items-center justify-between pb-8 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.appearance.darkPreset.title" defaultMessage="Dark Theme Preset" /></div>
                    <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.appearance.darkPreset.desc" defaultMessage="Color scheme for dark mode" /></div>
                </div>
                <ThemeDropdown
                    themes={darkThemes}
                    value={darkUITheme}
                    onChange={handleDarkUITheme}
                    selectedName={darkPreset?.name ?? 'Default'}
                    selectedPreview={darkPreset?.preview ?? '#8B7DF0'}
                />
            </div>

            {/* Light Mode Terminal Theme */}
            <div className="flex items-center justify-between pb-8 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.appearance.lightTerminal.title" defaultMessage="Light Mode Terminal Theme" /></div>
                    <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.appearance.lightTerminal.desc" defaultMessage="Color scheme for the embedded terminal in light mode" /></div>
                </div>
                <TerminalThemeDropdown
                    themes={lightTerminalThemes}
                    value={lightTerminalTheme}
                    onChange={setLightTerminalTheme}
                />
            </div>

            {/* Dark Mode Terminal Theme */}
            <div className="flex items-center justify-between pb-8 border-b border-border/60">
                <div>
                    <div className="text-sm font-medium mb-1"><FormattedMessage id="settings.appearance.darkTerminal.title" defaultMessage="Dark Mode Terminal Theme" /></div>
                    <div className="text-sm text-muted-foreground"><FormattedMessage id="settings.appearance.darkTerminal.desc" defaultMessage="Color scheme for the embedded terminal in dark mode" /></div>
                </div>
                <TerminalThemeDropdown
                    themes={darkTerminalThemes}
                    value={darkTerminalTheme}
                    onChange={setDarkTerminalTheme}
                />
            </div>

        </div>
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
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(!open)}
                className="flex items-center gap-2.5 px-3 py-1.5 bg-muted/30 rounded-lg border border-border/60 hover:bg-muted/50 transition-colors min-w-[160px]"
            >
                <span
                    className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                    style={{ backgroundColor: selectedPreview }}
                >
                    Aa
                </span>
                <span className="text-sm font-medium flex-1 text-left">{selectedName}</span>
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-1 w-[200px] bg-popover border border-border/60 rounded-xl shadow-float z-50 py-1 max-h-[320px] overflow-y-auto code-scrollbar">
                    {themes.map((t) => (
                        <button
                            key={t.id}
                            onClick={() => { onChange(t.id); setOpen(false) }}
                            className={cn(
                                "w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left",
                                value === t.id && "bg-muted/30"
                            )}
                        >
                            <span
                                className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                                style={{ backgroundColor: t.preview }}
                            >
                                Aa
                            </span>
                            <span className="flex-1">{t.name}</span>
                            {value === t.id && <Check className="w-3.5 h-3.5 text-brand" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
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
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const selected = themes.find((t) => t.id === value) ?? themes[0]

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(!open)}
                className="flex items-center gap-2.5 px-3 py-1.5 bg-muted/30 rounded-lg border border-border/60 hover:bg-muted/50 transition-colors min-w-[200px]"
            >
                {selected && <TerminalSwatch theme={selected} />}
                <span className="text-sm font-medium flex-1 text-left">{selected?.name ?? 'Default'}</span>
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-1 w-[240px] bg-popover border border-border/60 rounded-xl shadow-float z-50 py-1 max-h-[320px] overflow-y-auto code-scrollbar">
                    {themes.map((t) => (
                        <button
                            key={t.id}
                            onClick={() => { onChange(t.id); setOpen(false) }}
                            className={cn(
                                "w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left",
                                value === t.id && "bg-muted/30"
                            )}
                        >
                            <TerminalSwatch theme={t} />
                            <span className="flex-1">{t.name}</span>
                            {value === t.id && <Check className="w-3.5 h-3.5 text-brand" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
