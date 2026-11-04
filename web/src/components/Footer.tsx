import { Link } from 'react-router'
import { Wordmark } from './Logo'
import { SocialLinks } from './SocialLinks'
import { ANDROID_APK_URL, APP_URL, GITHUB_URL, IOS_APP_STORE_URL } from '../lib/links'
import { useCopy, type Locale } from '../lib/i18n'

interface FooterColumn {
  title: string
  links: { label: string; href: string; internal?: boolean; external?: boolean }[]
}

const COPY: Record<Locale, { tagline: string; rights: string; columns: FooterColumn[] }> = {
  en: {
    tagline: 'One interface for every coding agent.',
    rights: '© 2026 Operon. All rights reserved.',
    columns: [
      {
        title: 'Product',
        links: [
          { label: 'Download', href: '#download' },
          { label: 'Web app', href: APP_URL, external: true },
          { label: 'iOS app', href: IOS_APP_STORE_URL, external: true },
          { label: 'Android APK', href: ANDROID_APK_URL },
        ],
      },
      {
        title: 'Resources',
        links: [
          { label: 'Docs', href: '/docs', internal: true },
          { label: 'Releases', href: `${GITHUB_URL}/releases`, external: true },
          { label: 'Support', href: '/support', internal: true },
        ],
      },
      {
        title: 'Legal',
        links: [
          { label: 'Privacy', href: '/privacy', internal: true },
          { label: 'Terms', href: '/terms', internal: true },
        ],
      },
    ],
  },
  zh: {
    tagline: '一个界面，用上所有编程 Agent。',
    rights: '© 2026 Operon. 保留所有权利。',
    columns: [
      {
        title: '产品',
        links: [
          { label: '下载', href: '#download' },
          { label: '网页版', href: APP_URL, external: true },
          { label: 'iOS 应用', href: IOS_APP_STORE_URL, external: true },
          { label: 'Android APK', href: ANDROID_APK_URL },
        ],
      },
      {
        title: '资源',
        links: [
          { label: '文档', href: '/docs', internal: true },
          { label: '版本发布', href: `${GITHUB_URL}/releases`, external: true },
          { label: '支持', href: '/support', internal: true },
        ],
      },
      {
        title: '法律',
        links: [
          { label: '隐私政策', href: '/privacy', internal: true },
          { label: '服务条款', href: '/terms', internal: true },
        ],
      },
    ],
  },
}

const linkClass = 'text-[13px] text-muted-foreground transition-colors hover:text-foreground'

export function Footer() {
  const t = useCopy(COPY)

  return (
    <footer className="border-t border-border/40 bg-sidebar">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-12 pb-[calc(2.5rem+env(safe-area-inset-bottom))] md:grid-cols-[1.4fr_repeat(3,1fr)] md:px-8">
        <div>
          <Wordmark size="sm" />
          <p className="mt-3 max-w-xs text-[13px] leading-[1.6] text-muted-foreground">
            {t.tagline}
          </p>
          <div className="mt-4 -ml-2">
            <SocialLinks variant="navbar" />
          </div>
        </div>

        {t.columns.map((column) => (
          <div key={column.title}>
            <div className="text-[13px] font-medium text-foreground">{column.title}</div>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  {link.internal ? (
                    <Link to={link.href} className={linkClass}>
                      {link.label}
                    </Link>
                  ) : (
                    <a
                      href={link.href}
                      className={linkClass}
                      {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    >
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border/40">
        <div className="mx-auto max-w-6xl px-4 py-5 text-[12px] text-muted-foreground md:px-8">
          {t.rights}
        </div>
      </div>
    </footer>
  )
}
