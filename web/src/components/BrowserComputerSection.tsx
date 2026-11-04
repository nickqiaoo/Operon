import { useState, type ReactNode } from 'react'
import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Title, Window } from './ui'
import { cn } from '../lib/styles'
import { useCopy } from '../lib/i18n'

type TargetId = 'browser' | 'chrome' | 'mac'

/**
 * Tool calls stay as code in every language; their results come from `COPY`
 * by position. The last call is always the one still running.
 */
const TARGETS: { id: TargetId; icon: ReactNode; calls: string[] }[] = [
  {
    id: 'browser',
    icon: <GlobeIcon />,
    calls: [
      "browser.navigate('localhost:3000/checkout')",
      'browser.snapshot()',
      "browser.click('Place order')",
      'browser.screenshot()',
    ],
  },
  {
    id: 'chrome',
    icon: <TabIcon />,
    calls: [
      'chrome.tabs()',
      "chrome.claim('Analytics · Weekly')",
      "chrome.click('Export CSV')",
      'chrome.read()',
    ],
  },
  {
    id: 'mac',
    icon: <WindowIcon />,
    calls: [
      "app.open('Numbers')",
      "app.menu('File › Export To › PDF')",
      "app.hotkey('cmd+s')",
      'app.verify()',
    ],
  },
]

const COPY = {
  en: {
    eyebrow: 'Browser and Computer Use',
    titleA: 'Your agents ',
    titleB: 'have hands.',
    lead: 'Not just a panel to look at. Operon agents drive a built-in browser, your real Chrome and native Mac apps — clicking, typing and checking their own work. On popular sites they skip the clicking altogether.',
    window: 'Agent session',
    tablist: 'Target',
    targets: { browser: 'In-app browser', chrome: 'Your Chrome', mac: 'Mac apps' } as Record<TargetId, string>,
    running: 'running…',
    results: {
      browser: ['loaded in 240 ms', '38 interactive elements', 'navigated to /confirm'],
      chrome: ['7 open tabs', 'tab claimed', 'download started'],
      mac: ['in the background', 'dialog opened', 'saved'],
    } as Record<TargetId, string[]>,
    preview: { numbers: 'Numbers — Q3 report', export: 'Export' },
    features: [
      {
        title: 'In-app browser',
        desc: 'A browser beside the chat. Agents navigate, click, type and screenshot it — including your localhost dev server — and you can pin comments on elements to send back.',
      },
      {
        title: 'Your Chrome',
        desc: 'Drive your own Chrome with your real logins. Agents can take over a tab you already have open; permissions for both browsers live on one page.',
      },
      {
        title: 'Mac apps',
        desc: 'Computer Use reads and operates native apps in the background — clicks, keyboard shortcuts, menu bar items, window sizes and the clipboard — and checks that each action took effect.',
      },
      {
        title: 'You decide where',
        desc: 'Allow or block Computer Use app by app. Several conversations can use it at once, and the agent’s pointer shows on screen as it works.',
      },
    ],
  },
  zh: {
    eyebrow: '浏览器与 Computer Use',
    titleA: 'Agent 不只会写代码，',
    titleB: '还能上手操作。',
    lead: 'Operon 的 Agent 能操作内置浏览器、你自己的 Chrome，还有 Mac 上的原生应用：点击、输入，做完自己检查结果。常用网站还有现成的 Site Adapter，连点都不用点。',
    window: 'Agent 会话',
    tablist: '目标',
    targets: { browser: '内置浏览器', chrome: '你的 Chrome', mac: 'Mac 应用' } as Record<TargetId, string>,
    running: '执行中…',
    results: {
      browser: ['240 ms 加载完成', '38 个可交互元素', '已跳转到 /confirm'],
      chrome: ['7 个打开的 tab', '已接管 tab', '开始下载'],
      mac: ['在后台打开', '已弹出对话框', '已保存'],
    } as Record<TargetId, string[]>,
    preview: { numbers: 'Numbers — 第三季度报告', export: '导出' },
    features: [
      {
        title: '内置浏览器',
        desc: '浏览器就在对话旁边，Agent 可以在里面打开网页、点击、输入、截图，本地的 localhost 开发服务器也行。你也可以在页面元素上加评论，发给 Agent 去改。',
      },
      {
        title: '你的 Chrome',
        desc: 'Agent 直接操作你自己的 Chrome，登录状态都是现成的，也可以接手你已经打开的 tab。两个浏览器的权限在同一个页面里管。',
      },
      {
        title: 'Mac 应用',
        desc: 'Computer Use 在后台读取和操作原生应用，点击、快捷键、菜单栏、调整窗口、剪贴板都支持，每一步做完都会确认是否生效。',
      },
      {
        title: '能碰哪些应用你说了算',
        desc: '每个应用单独设置是否允许 Computer Use。多个对话可以同时用，Agent 操作时屏幕上会显示它的指针。',
      },
    ],
  },
}


export function BrowserComputerSection() {
  const [activeId, setActiveId] = useState<TargetId>('browser')
  const active = TARGETS.find((target) => target.id === activeId) ?? TARGETS[0]
  const t = useCopy(COPY)
  const steps = active.calls.map((call, i) => {
    const last = i === active.calls.length - 1
    return { call, result: last ? t.running : t.results[active.id][i], active: last }
  })

  return (
    <Section id="automation" tone="sidebar">
      <Reveal>
        <div className="max-w-2xl">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Title>
            {t.titleA}<Muted>{t.titleB}</Muted>
          </Title>
          <Lead>{t.lead}</Lead>
        </div>

        <div className="mt-10">
          <Window title={t.window}>
            <div className="flex gap-1 border-b border-border/50 px-3 py-2" role="tablist" aria-label={t.tablist}>
              {TARGETS.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  role="tab"
                  aria-selected={target.id === activeId}
                  onClick={() => setActiveId(target.id)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors',
                    target.id === activeId ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-secondary-hover hover:text-foreground',
                  )}
                >
                  {target.icon}
                  {t.targets[target.id]}
                </button>
              ))}
            </div>
            <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-2 p-4 font-mono text-[12px] md:p-5">
                {steps.map((step) => (
                  <div key={step.call} className="flex items-start gap-2.5">
                    <span
                      className={cn(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        step.active ? 'pulse-dot bg-brand' : 'bg-accent-green',
                      )}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-foreground">{step.call}</div>
                      <div className="text-muted-foreground">{step.result}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden border-l border-border/50 bg-sidebar p-5 md:block">
                <TargetPreview id={activeId} labels={t.preview} />
              </div>
            </div>
          </Window>
        </div>

        <div className="mt-10">
          <FeatureList items={t.features} columns={2} />
        </div>
      </Reveal>
    </Section>
  )
}

function TargetPreview({ id, labels }: { id: TargetId; labels: { numbers: string; export: string } }) {
  const url = id === 'browser' ? 'localhost:3000/checkout' : id === 'chrome' ? 'analytics.example.com/weekly' : null

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
      <div className="flex h-7 items-center gap-2 border-b border-border/50 px-2.5 text-[11px] text-muted-foreground">
        {url ? (
          <span className="flex-1 truncate rounded bg-muted px-2 py-0.5">{url}</span>
        ) : (
          <span>{labels.numbers}</span>
        )}
      </div>
      <div className="space-y-2.5 p-4">
        <div className="h-2.5 w-1/2 rounded bg-muted" />
        <div className="h-2 w-5/6 rounded bg-muted/70" />
        <div className="h-2 w-2/3 rounded bg-muted/70" />
        <div className="relative pt-2">
          <div className="inline-flex h-7 items-center rounded-lg bg-foreground px-3 text-[11px] text-background">
            {id === 'browser' ? 'Place order' : id === 'chrome' ? 'Export CSV' : labels.export}
          </div>
          {/* The agent's pointer */}
          <svg width="16" height="16" viewBox="0 0 24 24" className="absolute top-7 left-[84px] text-brand" aria-hidden>
            <path fill="currentColor" stroke="white" strokeWidth="1.5" d="M4 3l7 18 2.5-7.5L21 11z" />
          </svg>
        </div>
      </div>
    </div>
  )
}

function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  )
}

function TabIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18M8 5v4" />
    </svg>
  )
}

function WindowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 8h18" />
      <circle cx="6" cy="6" r=".5" fill="currentColor" />
    </svg>
  )
}
