import { getDownloadHref, redirectToDownload } from '../lib/download'
import { ANDROID_APK_URL, APP_URL, IOS_APP_STORE_URL } from '../lib/links'
import { OperonGlyph } from './Logo'
import { ArrowIcon, DownloadIcon } from './Navbar'
import { Reveal } from './Reveal'
import { Lead, Section, Title } from './ui'
import { buttonPrimary, buttonSecondary, cn } from '../lib/styles'
import appStoreBadge from '../assets/app-store-badge.svg'

export function DownloadSection() {
  const downloadHref = getDownloadHref('bottom_cta')

  return (
    <Section id="download" width="narrow" className="border-t border-border/40">
      <Reveal>
        <div className="text-center">
          <OperonGlyph size={40} className="mx-auto mb-6 text-brand" />
          <Title center>Ready when you are.</Title>
          <Lead center>
            Install Operon on your Mac and start running agents in minutes. Pair your phone or open the
            web app to keep going away from your desk.
          </Lead>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={downloadHref}
              className={cn(buttonPrimary, 'h-10 px-5')}
              onClick={(event) => {
                window.gtag?.('event', 'click_download', { event_category: 'engagement', event_label: 'bottom_cta' })
                event.preventDefault()
                void redirectToDownload('bottom_cta')
              }}
            >
              <DownloadIcon />
              Download for macOS
            </a>
            <a
              href={APP_URL}
              className={cn(buttonSecondary, 'h-10 px-5')}
              onClick={() => {
                window.gtag?.('event', 'click_open_app', { event_category: 'engagement', event_label: 'bottom_cta' })
              }}
            >
              Open web app
              <ArrowIcon />
            </a>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-5">
            {/* Official Apple badge; per Apple guidelines it must not be restyled. */}
            <a
              href={IOS_APP_STORE_URL}
              target="_blank"
              rel="noreferrer"
              className="transition-opacity hover:opacity-85"
              onClick={() => {
                window.gtag?.('event', 'click_download_ios', { event_category: 'engagement', event_label: 'bottom_cta' })
              }}
            >
              <img src={appStoreBadge} alt="Download on the App Store" className="block h-10" />
            </a>
            <a
              href={ANDROID_APK_URL}
              className="inline-flex items-center gap-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                window.gtag?.('event', 'click_download_android', { event_category: 'engagement', event_label: 'bottom_cta' })
              }}
            >
              <AndroidIcon />
              Android (APK)
            </a>
          </div>
        </div>
      </Reveal>
    </Section>
  )
}

function AndroidIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.6 9.48l1.84-3.18a.4.4 0 0 0-.7-.4l-1.87 3.23a11.4 11.4 0 0 0-9.74 0L5.26 5.9a.4.4 0 1 0-.7.4L6.4 9.48A10.9 10.9 0 0 0 1 18h22a10.9 10.9 0 0 0-5.4-8.52M7 15.25a1 1 0 1 1 1-1 1 1 0 0 1-1 1m10 0a1 1 0 1 1 1-1 1 1 0 0 1-1 1" />
    </svg>
  )
}
