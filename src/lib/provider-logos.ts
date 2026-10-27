import anthropicLogo from '@/assets/logos/claude.svg';
import openaiLogo from '@/assets/logos/openai.svg';
import googleLogo from '@/assets/logos/google.svg';
import deepseekLogo from '@/assets/logos/deepseek.svg';
import kimiLogo from '@/assets/logos/kimi.svg';
import glmLogo from '@/assets/logos/zhipuai.svg';
import minimaxLogo from '@/assets/logos/minimax.svg';
import grokLogo from '@/assets/logos/grok.svg';
import qoderLogo from '@/assets/logos/qoder.svg';
import opencodeLogo from '@/assets/logos/opencode.svg';
import vercelLogo from '@/assets/logos/vercel.svg';
import openrouterLogo from '@/assets/logos/openrouter.svg';
import customLogo from '@/assets/logos/custom.svg';
import endpointLogo from '@/assets/logos/endpoint.svg';
import copilotLogo from '@/assets/logos/copilot.svg';
import cursorLogo from '@/assets/logos/cursor.svg';
import antigravityLogo from '@/assets/logos/antigravity.svg';

/** Logo file (basename in `src/assets/logos`; also the iOS imageset and the Android drawable suffix) per provider / agent id. */
const PROVIDER_LOGO_NAMES: Record<string, string> = {
  anthropic: 'claude',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  kimi: 'kimi',
  moonshot: 'kimi',
  moonshotai: 'kimi',
  glm: 'zhipuai',
  zhipuai: 'zhipuai',
  minimax: 'minimax',
  grok: 'grok',
  xai: 'grok',
  qoder: 'qoder',
  claude: 'claude',
  opencode: 'opencode',
  vercel: 'vercel',
  openrouter: 'openrouter',
  custom: 'custom',
  // A user-added model provider (Settings → Providers → Custom).
  endpoint: 'endpoint',
  // Agent/adapter ID aliases
  'claude-code': 'claude',
  gemini: 'google',
  codex: 'openai',
  copilot: 'copilot',
  cursor: 'cursor',
  antigravity: 'antigravity',
};

const LOGO_FILES: Record<string, string> = {
  claude: anthropicLogo,
  openai: openaiLogo,
  google: googleLogo,
  deepseek: deepseekLogo,
  kimi: kimiLogo,
  zhipuai: glmLogo,
  minimax: minimaxLogo,
  grok: grokLogo,
  qoder: qoderLogo,
  opencode: opencodeLogo,
  vercel: vercelLogo,
  openrouter: openrouterLogo,
  custom: customLogo,
  endpoint: endpointLogo,
  copilot: copilotLogo,
  cursor: cursorLogo,
  antigravity: antigravityLogo,
};

/** The logo name for a provider / agent id, or null when there is none. Shared with both native shells, which name their own assets to match. */
export function providerLogoName(id: string | undefined | null): string | null {
  if (!id) return null;
  return PROVIDER_LOGO_NAMES[id] ?? PROVIDER_LOGO_NAMES[id.toLowerCase()] ?? null;
}

/** The logo image for a provider / agent id, or null when there is none. */
export function providerLogoSrc(id: string | undefined | null): string | null {
  const name = providerLogoName(id);
  return name ? LOGO_FILES[name] ?? null : null;
}
