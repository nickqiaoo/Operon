/**
 * Agent name colors — category colors (telling members apart), so literals.
 * Picked by agent id: ids are sequential, so agents created around the same
 * time (i.e. the ones that end up in one channel) never share a color.
 */
const AGENT_NAME_COLORS = [
  'text-[#C2410C] dark:text-[#FB923C]', // orange
  'text-[#047857] dark:text-[#34D399]', // emerald
  'text-[#6D28D9] dark:text-[#A78BFA]', // violet
  'text-[#1D4ED8] dark:text-[#60A5FA]', // blue
  'text-[#BE185D] dark:text-[#F472B6]', // pink
  'text-[#B45309] dark:text-[#FBBF24]', // amber
  'text-[#0E7490] dark:text-[#22D3EE]', // cyan
  'text-[#4D7C0F] dark:text-[#A3E635]', // lime
] as const

/** Per-agent name color, so members of a channel are easy to tell apart. */
export function agentNameColor(agentId: number | undefined): string {
  if (agentId == null) return 'text-tint'
  return AGENT_NAME_COLORS[Math.abs(agentId) % AGENT_NAME_COLORS.length]
}
