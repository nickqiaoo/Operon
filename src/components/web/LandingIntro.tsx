import { ArrowRight, BookOpen, Cloud, Globe, Monitor } from 'lucide-react'
import { useIntl } from 'react-intl'

export const DETAILED_GUIDE_URL = 'https://operon.chatcode.top/docs'

/**
 * Reusable product-intro section for the web entry point: a one-line pitch, an
 * interactive architecture diagram, and a link to the full guide.
 *
 * Kept self-contained (no app stores / electronAPI) so it can also be dropped into
 * an external marketing landing page.
 */
export function LandingIntro() {
  const intl = useIntl()

  return (
    <div className="space-y-10">
      <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
        {intl.formatMessage({
          id: 'web.auth.intro.body',
          defaultMessage:
            'operon runs on your own computer, right next to your code and your AI coding agents. Sign in to drive them from any browser — chat, review diffs, run terminals and manage tasks — while everything keeps executing on your machine.',
        })}
      </p>

      <ArchitectureDiagram />

      <a
        href={DETAILED_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-brand transition-colors hover:text-brand-soft"
      >
        <BookOpen className="h-3.5 w-3.5" />
        {intl.formatMessage({ id: 'web.auth.intro.guide', defaultMessage: 'Read the full setup guide' })}
        <ArrowRight className="h-3.5 w-3.5" />
      </a>
    </div>
  )
}

/**
 * Browser ⇄ Broker ⇄ Your machine, the path every tunneled request takes. Lays out
 * horizontally on desktop, stacks vertically on mobile.
 */
function ArchitectureDiagram() {
  const intl = useIntl()
  const nodes = [
    {
      key: 'browser',
      icon: Globe,
      title: intl.formatMessage({ id: 'web.auth.diagram.browser.title', defaultMessage: 'Web browser' }),
      sub: intl.formatMessage({ id: 'web.auth.diagram.browser.sub', defaultMessage: 'You, anywhere' }),
    },
    {
      key: 'broker',
      icon: Cloud,
      title: intl.formatMessage({ id: 'web.auth.diagram.broker.title', defaultMessage: 'Broker' }),
      sub: intl.formatMessage({ id: 'web.auth.diagram.broker.sub', defaultMessage: 'operon cloud' }),
    },
    {
      key: 'machine',
      icon: Monitor,
      title: intl.formatMessage({ id: 'web.auth.diagram.machine.title', defaultMessage: 'Your machine' }),
      sub: intl.formatMessage({ id: 'web.auth.diagram.machine.sub', defaultMessage: 'operon + agents + code' }),
    },
  ]
  return (
    <div className="rounded-xl border border-border/50 bg-muted/10 p-5">
      <div className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {intl.formatMessage({ id: 'web.auth.diagram.title', defaultMessage: 'How it connects' })}
      </div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        {nodes.map((n, i) => (
          <div key={n.key} className="contents">
            <div className="flex flex-1 items-center gap-3 rounded-lg border border-border/50 bg-background/50 p-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-muted text-brand">
                <n.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{n.title}</div>
                <div className="truncate text-xs text-muted-foreground">{n.sub}</div>
              </div>
            </div>
            {i < nodes.length - 1 && (
              <ArrowRight className="mx-auto h-4 w-4 shrink-0 rotate-90 text-muted-foreground/60 sm:rotate-0" />
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground/80">
        {intl.formatMessage({
          id: 'web.auth.diagram.note',
          defaultMessage:
            'The broker only relays — it never sees your code or runs your agents. Your machine dials out, so nothing inbound needs to be exposed.',
        })}
      </p>
    </div>
  )
}
