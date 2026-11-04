import type { ReactNode } from 'react'
import { cn } from '../lib/styles'
import { useCopy } from '../lib/i18n'
import heroLight from '../assets/shots/hero-light.webp'
import heroDark from '../assets/shots/hero-dark.webp'
import chatLight from '../assets/shots/phone-chat-light.webp'
import chatDark from '../assets/shots/phone-chat-dark.webp'

/**
 * Your Mac ⇄ Broker ⇄ browser / phone, the path every remote request takes
 * (see web/doc/remote-access.md). Both ends show the same capture on purpose:
 * the point is that the browser gets the desktop's interface, not a lite one.
 * The shots are the Hero's and the Mobile section's, so nothing extra loads.
 */

const COPY = {
  en: {
    label: 'How it connects',
    mac: {
      title: 'Your Mac',
      desc: 'Agents, repositories and terminals stay here. It connects out, so no port is ever opened.',
    },
    broker: { title: 'Broker', desc: 'Routes traffic, can’t read it' },
    lock: 'End-to-end encrypted',
    remote: {
      title: 'Any browser, iPhone or Android',
      desc: 'The same interface as the desktop, live — sessions, diffs, terminals and approvals. In a browser there is nothing to install.',
    },
    alt: 'The Operon desktop interface, shown both in the Mac app and in a web browser',
  },
  zh: {
    label: '连接方式',
    mac: {
      title: '你的 Mac',
      desc: '代码、Agent 和终端都在这台机器上跑。它主动连出去，不需要开放任何端口。',
    },
    broker: { title: 'Broker', desc: '只转发，看不到内容' },
    lock: '端到端加密',
    remote: {
      title: '任意浏览器、iPhone 或 Android',
      desc: '界面和桌面端一样，会话、diff、终端、审批实时同步。浏览器里打开就能用，不用装任何东西。',
    },
    alt: 'Operon 桌面端界面，同时显示在 Mac 应用和网页浏览器里',
  },
}

export function RemoteDiagram() {
  const t = useCopy(COPY)

  return (
    <div className="mt-16 md:mt-20">
      <div className="mb-5 text-[13px] font-medium text-muted-foreground">{t.label}</div>

      {/* Phones: one column, Mac → Broker → remote. From lg: windows and the
          Broker on one row, captions under the windows on the next. */}
      <div className="grid grid-cols-1 gap-x-0 gap-y-4 lg:grid-cols-[minmax(0,1fr)_260px_minmax(0,1fr)] lg:gap-y-5">
        <Frame className="order-1 lg:order-none" bar={<span className="text-[10.5px] text-muted-foreground">Operon</span>}>
          <Shot light={heroLight} dark={heroDark} alt={t.alt} />
        </Frame>

        <Broker className="order-3 lg:order-none" title={t.broker.title} desc={t.broker.desc} lock={t.lock} />

        <div className="relative order-4 lg:order-none">
          <Frame bar={<span className="w-full max-w-[220px] truncate rounded bg-muted px-2 py-0.5 text-center text-[10.5px] text-muted-foreground">app.operon.chatcode.top</span>}>
            <Shot light={heroLight} dark={heroDark} alt="" />
          </Frame>
          <div className="absolute -right-1 -bottom-5 w-[22%] min-w-[64px] rounded-[15%/7%] border border-border/60 bg-background p-[3px] shadow-float sm:-right-3">
            <div className="overflow-hidden rounded-[12%/5.5%] border border-border/50" style={{ aspectRatio: '1206 / 2622' }}>
              <picture>
                <source srcSet={chatDark} media="(prefers-color-scheme: dark)" />
                <img src={chatLight} alt="" loading="lazy" decoding="async" className="block h-full w-full object-cover object-top" />
              </picture>
            </div>
          </div>
        </div>

        <Caption className="order-2 lg:order-none" title={t.mac.title} desc={t.mac.desc} />
        <div className="hidden lg:block" />
        <Caption className="order-5 pr-[26%] lg:order-none" title={t.remote.title} desc={t.remote.desc} />
      </div>
    </div>
  )
}

function Frame({ bar, children, className }: { bar: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border/60 bg-background shadow-float', className)} aria-hidden>
      <div className="flex h-7 items-center gap-2 border-b border-border/50 bg-sidebar px-2.5">
        <div className="flex shrink-0 gap-1">
          <span className="h-2 w-2 rounded-full bg-border" />
          <span className="h-2 w-2 rounded-full bg-border" />
          <span className="h-2 w-2 rounded-full bg-border" />
        </div>
        <div className="flex min-w-0 flex-1 justify-center">{bar}</div>
        <div className="w-[34px] shrink-0" />
      </div>
      {children}
    </div>
  )
}

function Shot({ light, dark, alt }: { light: string; dark: string; alt: string }) {
  return (
    <picture>
      <source srcSet={dark} media="(prefers-color-scheme: dark)" />
      <img
        src={light}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="block aspect-[16/10] w-full object-cover object-top"
      />
    </picture>
  )
}

function Broker({ title, desc, lock, className }: { title: string; desc: string; lock: string; className?: string }) {
  return (
    <div className={cn('relative flex flex-col items-center justify-center py-6 lg:py-0', className)}>
      {/* The wire: vertical between stacked cards, horizontal between windows. */}
      <span className="absolute inset-y-0 left-1/2 border-l border-dashed border-border/60 lg:hidden" aria-hidden />
      <span className="absolute inset-x-0 top-1/2 hidden border-t border-dashed border-border/60 lg:block" aria-hidden />

      <div className="relative flex items-center gap-2.5 rounded-xl border border-border/60 bg-background px-3 py-2.5 shadow-card">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-muted text-brand">
          <CloudIcon />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground">{title}</div>
          <div className="text-[11.5px] leading-[1.35] text-muted-foreground">{desc}</div>
        </div>
      </div>
      <div className="relative mt-2 inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-[11px] text-status-ok">
        <LockIcon />
        {lock}
      </div>
    </div>
  )
}

function Caption({ title, desc, className }: { title: string; desc: string; className?: string }) {
  return (
    <div className={cn('border-l border-border/60 pl-4', className)}>
      <div className="text-[14.5px] font-medium text-foreground">{title}</div>
      <div className="mt-1 text-[14px] leading-[1.6] text-muted-foreground">{desc}</div>
    </div>
  )
}

function CloudIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.5 19H8a5 5 0 1 1 1.6-9.74A6 6 0 0 1 21 11.5a4 4 0 0 1-3.5 7.5z" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
