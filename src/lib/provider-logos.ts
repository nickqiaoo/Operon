import anthropicLogo from '@/assets/logos/claude.svg';
import openaiLogo from '@/assets/logos/openai.svg';
import googleLogo from '@/assets/logos/google.svg';
import deepseekLogo from '@/assets/logos/deepseek.svg';
import kimiLogo from '@/assets/logos/kimi.svg';
import glmLogo from '@/assets/logos/zhipuai.svg';
import minimaxLogo from '@/assets/logos/minimax.svg';
import grokLogo from '@/assets/logos/grok.svg';
import mistralLogo from '@/assets/logos/mistral.svg';
import qoderLogo from '@/assets/logos/qoder.svg';
import opencodeLogo from '@/assets/logos/opencode.svg';
import vercelLogo from '@/assets/logos/vercel.svg';
import openrouterLogo from '@/assets/logos/openrouter.svg';
import customLogo from '@/assets/logos/custom.svg';
import endpointLogo from '@/assets/logos/endpoint.svg';
import copilotLogo from '@/assets/logos/copilot.svg';
import cursorLogo from '@/assets/logos/cursor.svg';
import antigravityLogo from '@/assets/logos/antigravity.svg';
import { lobeProviderLogo } from './lobe-icons';

/** Logo file (basename in `src/assets/logos`; also the iOS imageset and the Android drawable suffix) per provider / agent id. */
const PROVIDER_LOGO_NAMES: Record<string, string> = {
  anthropic: 'claude',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  kimi: 'kimi',
  moonshot: 'kimi',
  moonshotai: 'kimi',
  'moonshotai-cn': 'kimi',
  'kimi-coding': 'kimi',
  glm: 'zhipuai',
  zhipuai: 'zhipuai',
  zai: 'zhipuai',
  'zai-coding-cn': 'zhipuai',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  grok: 'grok',
  xai: 'grok',
  mistral: 'mistral',
  qoder: 'qoder',
  claude: 'claude',
  opencode: 'opencode',
  'opencode-go': 'opencode',
  vercel: 'vercel',
  'vercel-ai-gateway': 'vercel',
  openrouter: 'openrouter',
  custom: 'custom',
  // A user-added model provider (Settings → Providers → Custom).
  endpoint: 'endpoint',
  // Agent/adapter ID aliases
  'claude-code': 'claude',
  gemini: 'google',
  codex: 'openai',
  copilot: 'copilot',
  'github-copilot': 'copilot',
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
  mistral: mistralLogo,
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
  const lobeLogo = lobeProviderLogo(id);
  if (lobeLogo) return lobeLogo;
  const name = providerLogoName(id);
  return name ? LOGO_FILES[name] ?? null : null;
}

const MODEL_BRANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude(?:[-.\d]|$)/, 'claude'],
  [/^(?:gpt|chatgpt|o[134])(?:[-.\d]|$)/, 'openai'],
  [/^gemini(?:[-.\d]|$)/, 'gemini'],
  [/^deepseek(?:[-.\d]|$)/, 'deepseek'],
  [/^(?:kimi|moonshot)(?:[-.\d]|$)/, 'kimi'],
  [/^(?:glm|chatglm)(?:[-.\d]|$)/, 'zhipu'],
  [/^minimax(?:[-.\d]|$)/, 'minimax'],
  [/^grok(?:[-.\d]|$)/, 'grok'],
  [/^(?:qwen|qwq)(?:[-.\d]|$)/, 'qwen'],
  [/^llama(?:[-.\d]|$)/, 'meta'],
  [/^(?:mistral|mixtral|codestral|devstral|magistral|pixtral|ministral)(?:[-.\d]|$)/, 'mistral'],
  [/^command(?:[-.\d]|$)/, 'cohere'],
  [/^sonar(?:[-.\d]|$)/, 'perplexity'],
  [/^doubao(?:[-.\d]|$)/, 'doubao'],
  [/^step(?:[-.\d]|$)/, 'stepfun'],
  [/^mimo(?:[-.\d]|$)/, 'xiaomi'],
];

/** Match the model family even when it is served through a gateway. */
export function modelLogoSrc(model: string, provider?: string): string | null {
  const family = model.toLowerCase().split('/').pop() ?? '';
  const brand = MODEL_BRANDS.find(([pattern]) => pattern.test(family))?.[1];
  return (brand ? lobeProviderLogo(brand) : null) ?? providerLogoSrc(provider ?? model.split('/')[0]);
}
