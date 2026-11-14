import claude from '@lobehub/icons-static-svg/icons/claude.svg'
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg'
import openai from '@lobehub/icons-static-svg/icons/openai.svg'
import gemini from '@lobehub/icons-static-svg/icons/gemini.svg'
import google from '@lobehub/icons-static-svg/icons/google.svg'
import deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg'
import kimi from '@lobehub/icons-static-svg/icons/kimi.svg'
import zhipu from '@lobehub/icons-static-svg/icons/zhipu.svg'
import xai from '@lobehub/icons-static-svg/icons/xai.svg'
import grok from '@lobehub/icons-static-svg/icons/grok.svg'
import qwen from '@lobehub/icons-static-svg/icons/qwen.svg'
import ling from '@lobehub/icons-static-svg/icons/ling.svg'
import xiaomi from '@lobehub/icons-static-svg/icons/xiaomimimo.svg'
import fireworks from '@lobehub/icons-static-svg/icons/fireworks.svg'
import together from '@lobehub/icons-static-svg/icons/together.svg'
import copilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg'
import alibaba from '@lobehub/icons-static-svg/icons/alibaba.svg'
import nvidia from '@lobehub/icons-static-svg/icons/nvidia.svg'
import vercel from '@lobehub/icons-static-svg/icons/vercel.svg'
import bedrock from '@lobehub/icons-static-svg/icons/bedrock.svg'
import azure from '@lobehub/icons-static-svg/icons/azure.svg'
import baseten from '@lobehub/icons-static-svg/icons/baseten.svg'
import cerebras from '@lobehub/icons-static-svg/icons/cerebras.svg'
import cloudflare from '@lobehub/icons-static-svg/icons/cloudflare.svg'
import groq from '@lobehub/icons-static-svg/icons/groq.svg'
import huggingface from '@lobehub/icons-static-svg/icons/huggingface.svg'
import meta from '@lobehub/icons-static-svg/icons/meta.svg'
import cursor from '@lobehub/icons-static-svg/icons/cursor.svg'
import antigravity from '@lobehub/icons-static-svg/icons/antigravity.svg'
import qoder from '@lobehub/icons-static-svg/icons/qoder.svg'
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg'
import minimax from '@lobehub/icons-static-svg/icons/minimax.svg'
import mistral from '@lobehub/icons-static-svg/icons/mistral.svg'
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg'
import deepinfra from '@lobehub/icons-static-svg/icons/deepinfra.svg'
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg'
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg'
import perplexity from '@lobehub/icons-static-svg/icons/perplexity.svg'
import cohere from '@lobehub/icons-static-svg/icons/cohere.svg'
import doubao from '@lobehub/icons-static-svg/icons/doubao.svg'
import yi from '@lobehub/icons-static-svg/icons/yi.svg'
import stepfun from '@lobehub/icons-static-svg/icons/stepfun.svg'
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg'
import siliconcloud from '@lobehub/icons-static-svg/icons/siliconcloud.svg'
import aihubmix from '@lobehub/icons-static-svg/icons/aihubmix.svg'
import modelscope from '@lobehub/icons-static-svg/icons/modelscope.svg'

// Explicit imports keep unused icons out of the app bundle.
const logos: Record<string, string> = {
  claude,
  anthropic,
  openai,
  gemini,
  google,
  deepseek,
  kimi,
  zhipu,
  xai,
  grok,
  qwen,
  ling,
  xiaomi,
  fireworks,
  together,
  copilot,
  alibaba,
  nvidia,
  vercel,
  bedrock,
  azure,
  baseten,
  cerebras,
  cloudflare,
  groq,
  huggingface,
  meta,
  cursor,
  antigravity,
  qoder,
  opencode,
  minimax,
  mistral,
  openrouter,
  deepinfra,
  ollama,
  lmstudio,
  perplexity,
  cohere,
  doubao,
  yi,
  stepfun,
  moonshot,
  siliconcloud,
  aihubmix,
  modelscope,
}

const aliases: Record<string, string> = {
  'claude-code': 'claude',
  'codex': 'openai',
  'openai-codex': 'openai',
  'amazon-bedrock': 'bedrock',
  'google-vertex': 'google',
  'google-vertex-anthropic': 'anthropic',
  'github-copilot': 'copilot',
  'github-models': 'copilot',
  'cloudflare-ai-gateway': 'cloudflare',
  'cloudflare-workers-ai': 'cloudflare',
  'fireworks-ai': 'fireworks',
  'togetherai': 'together',
  'vercel-ai-gateway': 'vercel',
  'opencode-go': 'opencode',
  'moonshotai': 'moonshot',
  'moonshotai-cn': 'moonshot',
  'kimi-coding': 'kimi',
  'glm': 'zhipu',
  'zhipuai': 'zhipu',
  'zhipuai-coding-plan': 'zhipu',
  'zai': 'zhipu',
  'zai-coding-plan': 'zhipu',
  'zai-coding-cn': 'zhipu',
  'minimax-cn': 'minimax',
  'ant-ling': 'ling',
  'alibaba-cn': 'alibaba',
  'qwen-token-plan': 'qwen',
  'qwen-token-plan-cn': 'qwen',
  'qwen-token-plan-individual': 'qwen',
  'qwen-token-plan-individual-cn': 'qwen',
  'xiaomi-token-plan-ams': 'xiaomi',
  'xiaomi-token-plan-cn': 'xiaomi',
  'xiaomi-token-plan-sgp': 'xiaomi',
}

/** Local LobeHub assets; unknown providers let callers keep their generic fallback. */
export function lobeProviderLogo(id: string | undefined | null): string | null {
  const key = id?.toLowerCase() ?? ''
  return logos[aliases[key] ?? key] ?? null
}
