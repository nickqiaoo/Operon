import { useIntl } from "react-intl"
import { Hexagon } from "lucide-react"

// The provider logo set already covers every agent Operon drives, so the skill page
// reuses it rather than shipping a second, drifting copy.
import { ProviderIcon } from "@/components/editor/components/ModelSelectorPanel"
import { cn } from "@/lib/utils"

/**
 * Display names for the agent ids the skill installer reports.
 *
 * Keep in sync with `SKILL_TARGETS` in `server/src/services/skill-targets.ts` — an id
 * missing here still renders, just with its raw id as the label.
 */
const AGENT_LABELS: Record<string, string> = {
  operon: "Operon",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  kimi: "Kimi",
  opencode: "OpenCode",
  grok: "Grok",
}

export function agentLabel(id: string): string {
  return AGENT_LABELS[id] ?? id
}

/**
 * Operon has no entry in the shared logo set: its mark is a colour gradient, and the
 * provider icons are monochrome art that gets inverted in dark mode. A lucide glyph
 * sits in that row without breaking it.
 */
function AgentIcon({ id, size }: { id: string; size: number }) {
  if (id === "operon") {
    return <Hexagon style={{ width: size, height: size }} className="shrink-0 text-muted-foreground" />
  }
  return <ProviderIcon id={id} size={size} />
}

/**
 * The agents that can see a skill, as a row of logos.
 *
 * A count alone ("7 agents") doesn't answer the question users actually have, which is
 * *which* agents — most importantly whether the one they're about to chat with is in
 * the list.
 */
export function AgentBadges({
  agents,
  size = 13,
  max = 5,
  className,
}: {
  agents: string[]
  size?: number
  /** Logos shown before collapsing the rest into a `+N`. */
  max?: number
  className?: string
}) {
  const intl = useIntl()
  if (agents.length === 0) return null

  const shown = agents.slice(0, max)
  const overflow = agents.length - shown.length
  const fullList = agents.map(agentLabel).join(", ")

  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1", className)}
      title={intl.formatMessage(
        { id: "skill.agentsTooltip", defaultMessage: "Available in: {agents}" },
        { agents: fullList },
      )}
    >
      {shown.map((id) => (
        <AgentIcon key={id} id={id} size={size} />
      ))}
      {overflow > 0 && <span className="text-[10px] text-muted-foreground/70">+{overflow}</span>}
    </span>
  )
}

/** Same information with names attached, for the detail screen where there is room. */
export function AgentChips({ agents }: { agents: string[] }) {
  if (agents.length === 0) return null
  return (
    <>
      {agents.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
        >
          <AgentIcon id={id} size={12} />
          {agentLabel(id)}
        </span>
      ))}
    </>
  )
}
