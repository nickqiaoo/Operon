import { getDownloadHref, redirectToDownload } from '../lib/download'
import { APP_URL } from '../lib/links'
import { ArrowIcon, DownloadIcon } from './Navbar'
import { MaskIcon, ThemedShot } from './ui'
import { buttonPrimary, buttonSecondary, cn } from '../lib/styles'
import { AGENT_MARKS } from './agentMarks'
import heroLight from '../assets/shots/hero-light.webp'
import heroDark from '../assets/shots/hero-dark.webp'
import { useCopy } from '../lib/i18n'

const COPY = {
  en: {
    badge: 'An assistant that runs your coding agents',
    titleA: 'One interface.',
    titleB: 'Every coding agent.',
    lead: 'Run Claude Code, Codex, Cursor, OpenCode and more side by side, hand work between them, and let an assistant keep it moving across your projects — on your Mac, in the browser and on your phone.',
    download: 'Download for macOS',
    openWeb: 'Open web app',
    platforms: 'Free · macOS · iOS · Android · Web',
    alt: 'Operon with a Codex conversation that added a CSV export, and its diff open in the review panel',
  },
  zh: {
    badge: '帮你指挥编程 Agent 的助理',
    titleA: '一个界面，',
    titleB: '用上所有编程 Agent。',
    lead: 'Claude Code、Codex、Cursor、OpenCode 可以同时开着用，活儿能在它们之间来回交接，还有个助理帮你盯着各个项目的进度。Mac、浏览器、手机都能用。',
    download: '下载 macOS 版',
    openWeb: '打开网页版',
    platforms: '免费 · macOS · iOS · Android · 网页',
    alt: 'Operon 中一段 Codex 对话新增了 CSV 导出，右侧审阅面板展示对应 diff',
  },
}

/**
 * Settled, centred hero: what it is, who it works with, and the product
 * itself — a real capture from a demo profile, in the visitor's theme.
 */
export function HeroSection() {
  const downloadHref = getDownloadHref('hero')
  const t = useCopy(COPY)

  return (
    <section id="top" className="relative overflow-hidden bg-gradient-to-b from-sidebar to-background pt-28 pb-16 md:pt-36 md:pb-24">
      <div className="mx-auto max-w-6xl px-4 text-center md:px-8">
        <a
          href="#assistant"
          className="mx-auto mb-7 inline-flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-background py-1 pr-3 pl-1 text-[13px] text-muted-foreground shadow-card transition-colors hover:bg-secondary-hover hover:text-foreground"
        >
          <span className="rounded-full bg-brand-muted px-2 py-0.5 text-[12px] font-medium text-brand">New</span>
          <span className="truncate">{t.badge}</span>
          <ArrowIcon size={13} />
        </a>

        <h1 className="font-display text-[42px] leading-[1.04] font-semibold tracking-[-0.035em] text-foreground sm:text-[56px] md:text-[72px]">
          {t.titleA}
          <br />
          <span className="text-muted-foreground">{t.titleB}</span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-[16px] leading-[1.7] text-muted-foreground md:text-[18px]">
          {t.lead}
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a
            href={downloadHref}
            className={cn(buttonPrimary, 'h-10 px-5')}
            onClick={(event) => {
              window.gtag?.('event', 'click_download', { event_category: 'engagement', event_label: 'hero' })
              event.preventDefault()
              void redirectToDownload('hero')
            }}
          >
            <DownloadIcon />
            {t.download}
          </a>
          <a
            href={APP_URL}
            className={cn(buttonSecondary, 'h-10 px-5')}
            onClick={() => {
              window.gtag?.('event', 'click_open_app', { event_category: 'engagement', event_label: 'hero' })
            }}
          >
            {t.openWeb}
            <ArrowIcon />
          </a>
        </div>
        <p className="mt-4 text-[13px] text-muted-foreground">{t.platforms}</p>

        <div className="mx-auto mt-10 flex max-w-4xl flex-wrap items-center justify-center gap-x-6 gap-y-3 text-muted-foreground">
          {AGENT_MARKS.map((mark) => (
            <span key={mark.name} className="inline-flex items-center gap-2 text-[13px]">
              <MaskIcon src={mark.icon} size={16} />
              {mark.name}
            </span>
          ))}
        </div>

        <div className="relative mx-auto mt-14 max-w-5xl">
          <ThemedShot
            light={heroLight}
            dark={heroDark}
            alt={t.alt}
            aspect="1440 / 1000"
            className="shadow-modal"
            eager
          />
        </div>
      </div>
    </section>
  )
}
