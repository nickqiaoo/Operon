import claudeLogo from "@/assets/logos/claude.svg"
import openaiLogo from "@/assets/logos/openai.svg"
import opencodeLogo from "@/assets/logos/opencode.svg"
import kimiLogo from "@/assets/logos/kimi.svg"
import grokLogo from "@/assets/logos/grok.svg"
import copilotLogo from "@/assets/logos/copilot.svg"
import operonLogo from "@/assets/logos/custom.svg"
import { cn } from "@/lib/utils"

export function ClaudeCodeIcon({ className }: { className?: string }) {
    return <img src={claudeLogo} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function CodexIcon({ className }: { className?: string }) {
    return <img src={openaiLogo} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function OpenCodeIcon({ className }: { className?: string }) {
    return <img src={opencodeLogo} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function KimiIcon({ className }: { className?: string }) {
    return <img src={kimiLogo} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function GrokIcon({ className }: { className?: string }) {
    return <img src={grokLogo} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function CopilotIcon({ className }: { className?: string }) {
    return <img src={copilotLogo} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}

export function OperonIcon({ className }: { className?: string }) {
    return <img src={operonLogo} alt="" className={cn(className, "dark:invert dark:brightness-90")} />
}
