import { useState } from 'react'
import { Reveal } from './Reveal'
import { Eyebrow, Lead, MaskIcon, Muted, Section, Title } from './ui'
import { cn } from '../lib/styles'
import { AGENT_ICONS } from './agentMarks'

import { useCopy, useLocale, type Locale } from '../lib/i18n'

interface Adapter {
  id: string
  name: string
  icon: string
  copy: Record<Locale, { vendor: string; description: string; features: string[] }>
}

const ADAPTERS: Adapter[] = [
  {
    id: 'operon',
    name: 'Operon Agent',
    icon: AGENT_ICONS.operon,
    copy: {
      en: {
        vendor: 'Built in · any model',
        description:
          "Operon's own agent, not a wrapper around someone else's CLI. Bring a key for any of 8+ model providers and get the built-in tools, skills, MCP, memory, browser and Computer Use out of the box.",
        features: ['8+ model providers', 'Built-in tool system', 'Skills, MCP and plugins', 'Browser and Computer Use'],
      },
      zh: {
        vendor: '内置 · 任意模型',
        description:
          'Operon 自研的 Agent，不是套在别人 CLI 外面的壳。填上 8+ 家模型供应商任意一家的 key，内置工具、Skills、MCP、记忆、浏览器和 Computer Use 开箱即用。',
        features: ['8+ 家模型供应商', '内置工具体系', 'Skills、MCP 与插件', '浏览器与 Computer Use'],
      },
    },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: AGENT_ICONS.claude,
    copy: {
      en: {
        vendor: 'Anthropic',
        description:
          'Runs on the Claude Agent SDK with your own subscription. Permission modes, thinking levels, sub-agents, background agents and slash commands all have proper UI, and your 5-hour and weekly usage sits in the title bar.',
        features: ['Permission modes incl. auto', 'Sub-agents and background agents', 'Slash commands', 'Live usage limits'],
      },
      zh: {
        vendor: 'Anthropic',
        description:
          '基于 Claude Agent SDK，用你自己的订阅。权限模式、思考强度、子 Agent、后台 Agent 和斜杠命令都有完整界面，5 小时和每周额度就显示在标题栏。',
        features: ['权限模式（含 auto）', '子 Agent 与后台 Agent', '斜杠命令', '实时额度'],
      },
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: AGENT_ICONS.openai,
    copy: {
      en: {
        vendor: 'OpenAI',
        description:
          'Built on the Codex App Server with full session management. Plan mode, fast mode, side chats, goals and sandbox modes, with your plan’s rate limits one hover away.',
        features: ['Plan and fast mode', 'Side chats', 'Sandbox modes', 'Rate-limit badge'],
      },
      zh: {
        vendor: 'OpenAI',
        description:
          '基于 Codex App Server，会话管理完整。Plan 模式、Fast 模式、旁支对话、Goal 和沙箱模式都支持，套餐额度鼠标一悬停就能看到。',
        features: ['Plan 与 Fast 模式', '旁支对话', '沙箱模式', '额度徽标'],
      },
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: AGENT_ICONS.cursor,
    copy: {
      en: {
        vendor: 'Cursor',
        description:
          'Built on cursor-agent. Plan, Ask and Agent modes with the live model list from your account, and conversations that pick up where they left off after a restart.',
        features: ['Plan · Ask · Agent', 'Your account’s models', 'Session resume', 'Rich tool UI'],
      },
      zh: {
        vendor: 'Cursor',
        description:
          '基于 cursor-agent。支持 Plan、Ask、Agent 三种模式，模型列表实时取自你的账号，重启后对话也能接着上次继续。',
        features: ['Plan · Ask · Agent', '你账号下的模型', '会话恢复', '完整工具界面'],
      },
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    icon: AGENT_ICONS.opencode,
    copy: {
      en: {
        vendor: 'Open source',
        description:
          'Built on the OpenCode SDK with full feature parity. Use GLM, DeepSeek and every other provider OpenCode supports, with several tabs open at once and no crossed wires.',
        features: ['OpenCode SDK', 'Any OpenCode provider', 'Parallel tabs', 'Rich tool UI'],
      },
      zh: {
        vendor: '开源',
        description:
          '基于 OpenCode SDK，功能完全对齐。GLM、DeepSeek 以及 OpenCode 支持的所有供应商都能用，同时开多个 tab 也互不串线。',
        features: ['OpenCode SDK', '任意 OpenCode 供应商', '多 tab 并行', '完整工具界面'],
      },
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    icon: AGENT_ICONS.copilot,
    copy: {
      en: {
        vendor: 'GitHub',
        description:
          'Built on the Copilot SDK. Interactive, Plan and Autopilot modes, configurable reasoning effort, and the model list that comes with your plan.',
        features: ['Interactive · Plan · Autopilot', 'Reasoning effort', 'Plan-specific models', 'Rich tool UI'],
      },
      zh: {
        vendor: 'GitHub',
        description:
          '基于 Copilot SDK。支持 Interactive、Plan、Autopilot 三种模式，推理强度可调，模型列表跟随你的套餐。',
        features: ['Interactive · Plan · Autopilot', '推理强度', '套餐专属模型', '完整工具界面'],
      },
    },
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    icon: AGENT_ICONS.google,
    copy: {
      en: {
        vendor: 'Google',
        description:
          'Google Antigravity over ACP. Settings installs it for you and tells you whether you are signed in, so a login page never appears halfway through a conversation.',
        features: ['One-click setup', 'Sign-in status', 'Session resume', 'Skills support'],
      },
      zh: {
        vendor: 'Google',
        description:
          '通过 ACP 接入 Google Antigravity。设置页帮你一键安装并显示登录状态，聊到一半不会突然跳出登录页。',
        features: ['一键安装', '登录状态', '会话恢复', '支持 Skills'],
      },
    },
  },
  {
    id: 'grok',
    name: 'Grok',
    icon: AGENT_ICONS.grok,
    copy: {
      en: {
        vendor: 'xAI',
        description:
          'Grok over ACP. Chat with it directly, or have another agent hand it a piece of work and report back.',
        features: ['ACP integration', 'Session resume', 'Takes delegated work', 'Rich tool UI'],
      },
      zh: {
        vendor: 'xAI',
        description: '通过 ACP 接入 Grok。可以直接和它对话，也可以让别的 Agent 把一块活交给它、做完再汇报。',
        features: ['ACP 接入', '会话恢复', '可接受委派', '完整工具界面'],
      },
    },
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    icon: AGENT_ICONS.kimi,
    copy: {
      en: {
        vendor: 'Moonshot',
        description:
          "Moonshot's coding agent. Default, Plan and Full Access modes, slash commands like /compact, and streaming tool calls.",
        features: ['Default · Plan · Full Access', 'Slash commands', 'Session resume', 'Streaming tool calls'],
      },
      zh: {
        vendor: '月之暗面',
        description: '月之暗面的编程 Agent。支持 Default、Plan、Full Access 三种模式，/compact 等斜杠命令，以及流式工具调用。',
        features: ['Default · Plan · Full Access', '斜杠命令', '会话恢复', '流式工具调用'],
      },
    },
  },
]

const COPY = {
  en: {
    eyebrow: 'Agents',
    titleA: 'An agent of our own. ',
    titleB: 'And every CLI you already pay for.',
    lead: 'Each agent runs on its official SDK or protocol, with your own login and subscription. Operon gives all of them the same chat, diff, review, terminal and approvals — and lets them work together.',
  },
  zh: {
    eyebrow: 'Agent',
    titleA: '有自研 Agent，',
    titleB: '也接上你已经付费的每个 CLI。',
    lead: '每个 Agent 都跑在官方 SDK 或协议上，用你自己的登录和订阅。Operon 给它们同一套对话、diff、审阅、终端和审批，还能让它们协同干活。',
  },
}

export function AdaptersSection() {
  const [activeId, setActiveId] = useState(ADAPTERS[0].id)
  const active = ADAPTERS.find((a) => a.id === activeId) ?? ADAPTERS[0]
  const t = useCopy(COPY)
  const { locale } = useLocale()

  return (
    <Section id="agents">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Title>
            {t.titleA}<Muted>{t.titleB}</Muted>
          </Title>
          <Lead>{t.lead}</Lead>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div
            role="tablist"
            aria-label="Agents"
            className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
          >
            {ADAPTERS.map((adapter) => {
              const isActive = adapter.id === activeId
              return (
                <button
                  key={adapter.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveId(adapter.id)}
                  className={cn(
                    'flex h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-left transition-colors',
                    isActive
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary-hover hover:text-foreground',
                  )}
                >
                  <MaskIcon src={adapter.icon} size={16} />
                  <span className="text-[14px] whitespace-nowrap">{adapter.name}</span>
                  <span className="ml-auto hidden text-[12px] text-muted-foreground lg:inline">{adapter.copy[locale].vendor}</span>
                </button>
              )
            })}
          </div>

          <div className="rounded-xl border border-border/60 bg-sidebar p-6 md:p-8">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/60 bg-background text-foreground">
                <MaskIcon src={active.icon} size={20} />
              </span>
              <div>
                <div className="text-[17px] font-semibold text-foreground">{active.name}</div>
                <div className="text-[13px] text-muted-foreground">{active.copy[locale].vendor}</div>
              </div>
            </div>
            <p className="mt-5 max-w-2xl text-[15px] leading-[1.7] text-muted-foreground">{active.copy[locale].description}</p>
            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              {active.copy[locale].features.map((feature) => (
                <div
                  key={feature}
                  className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-background px-3 py-2.5 text-[13.5px] text-foreground"
                >
                  <CheckIcon />
                  {feature}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
