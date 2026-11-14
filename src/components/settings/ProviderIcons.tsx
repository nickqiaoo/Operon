import { providerLogoSrc } from "@/lib/provider-logos"
import operonLogo from "@/assets/logos/custom.svg"
import { cn } from "@/lib/utils"

export function ClaudeCodeIcon({ className }: { className?: string }) {
    return <img src={providerLogoSrc("claude-code") ?? undefined} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function CodexIcon({ className }: { className?: string }) {
    return <img src={providerLogoSrc("codex") ?? undefined} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function OpenCodeIcon({ className }: { className?: string }) {
    return <img src={providerLogoSrc("opencode") ?? undefined} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function KimiIcon({ className }: { className?: string }) {
    return <img src={providerLogoSrc("kimi") ?? undefined} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function GrokIcon({ className }: { className?: string }) {
    return <img src={providerLogoSrc("grok") ?? undefined} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function QoderIcon({ className }: { className?: string }) {
    return <img src={providerLogoSrc("qoder") ?? undefined} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function CopilotIcon({ className }: { className?: string }) {
    return <img src={providerLogoSrc("copilot") ?? undefined} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function AntigravityIcon({ className }: { className?: string }) {
    return <img src={providerLogoSrc("antigravity") ?? undefined} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function OperonIcon({ className }: { className?: string }) {
    return <img src={operonLogo} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}
