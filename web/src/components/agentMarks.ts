import claudeIcon from '../assets/claude.svg'
import openaiIcon from '../assets/openai.svg'
import opencodeIcon from '../assets/opencode.svg'
import kimiIcon from '../assets/kimi.svg'
import operonIcon from '../assets/operon-white.svg'
import copilotIcon from '../assets/copilot.svg'
import cursorIcon from '../assets/cursor.svg'
import googleIcon from '../assets/google.svg'
import grokIcon from '../assets/grok.svg'

/** Monochrome marks for the "works with" strip; drawn through MaskIcon. */
export const AGENT_MARKS = [
  { name: 'Claude Code', icon: claudeIcon },
  { name: 'Codex', icon: openaiIcon },
  { name: 'Cursor', icon: cursorIcon },
  { name: 'OpenCode', icon: opencodeIcon },
  { name: 'Copilot', icon: copilotIcon },
  { name: 'Antigravity', icon: googleIcon },
  { name: 'Grok', icon: grokIcon },
  { name: 'Kimi', icon: kimiIcon },
  { name: 'Operon Agent', icon: operonIcon },
]

export const AGENT_ICONS = {
  claude: claudeIcon,
  openai: openaiIcon,
  opencode: opencodeIcon,
  kimi: kimiIcon,
  operon: operonIcon,
  copilot: copilotIcon,
  cursor: cursorIcon,
  google: googleIcon,
  grok: grokIcon,
}
