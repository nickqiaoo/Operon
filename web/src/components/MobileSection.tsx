import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Split, Title } from './ui'
import { cn } from '../lib/styles'
import boardLight from '../assets/shots/phone-board-light.webp'
import boardDark from '../assets/shots/phone-board-dark.webp'
import chatLight from '../assets/shots/phone-chat-light.webp'
import chatDark from '../assets/shots/phone-chat-dark.webp'
import diffLight from '../assets/shots/phone-diff-light.webp'
import diffDark from '../assets/shots/phone-diff-dark.webp'

const FEATURES = [
  {
    title: 'Native iOS and Android apps',
    desc: 'Native tab bar, navigation and sheets. iOS is on the App Store; Android installs from a signed APK on this site.',
  },
  {
    title: 'The full web app',
    desc: 'The same interface as the desktop in any browser, with the same sessions, diffs, approvals and tools.',
  },
  {
    title: 'End-to-end encrypted',
    desc: 'Content is encrypted between each device and your Mac. New phones and browsers are approved from the desktop only.',
  },
  {
    title: 'Pushes when you step away',
    desc: 'Notifications wait while you are at the computer and arrive once you leave. Telegram and Slack bots cover quick replies.',
  },
]

export function MobileSection() {
  return (
    <Section id="mobile">
      <Reveal>
        <Split
          copy={
            <>
              <Eyebrow>Mobile and web</Eyebrow>
              <Title>
                Away from your desk. <Muted>Still in charge.</Muted>
              </Title>
              <Lead>
                Pair your phone or open the web app and pick up exactly where the desktop is — answer an
                approval on the bus, check a diff in bed, ask the assistant how things went.
              </Lead>
              <div className="mt-8">
                <FeatureList items={FEATURES} />
              </div>
            </>
          }
          visual={
            /* Left to right, the trip a phone check takes: the board, the
               conversation that finished, the diff it left. The middle one leads;
               on a phone-width page only it is shown. */
            <div className="flex items-start justify-center gap-3 sm:gap-4">
              <PhoneMock
                light={boardLight}
                dark={boardDark}
                alt="Operon on iPhone: tasks grouped by status, one of them a spec that agents are still designing"
                className="mt-10 hidden w-[180px] sm:block lg:w-[190px]"
              />
              <PhoneMock
                light={chatLight}
                dark={chatDark}
                alt="A Codex conversation on iPhone that added a CSV export, ending with the card of files it edited"
                className="relative z-10 w-[240px] sm:w-[210px] lg:w-[220px]"
              />
              <PhoneMock
                light={diffLight}
                dark={diffDark}
                alt="The diff of src/server.ts from that conversation, on iPhone"
                className="mt-10 hidden w-[180px] sm:block lg:w-[190px]"
              />
            </div>
          }
        />
      </Reveal>
    </Section>
  )
}

/**
 * An iPhone frame around a light and a dark capture. The radii are a share of
 * the frame's own size, so any width reads as the same phone; the bezel is in
 * px because a padding percentage is taken from the parent's width.
 */
function PhoneMock({ light, dark, alt, className }: { light: string; dark: string; alt: string; className?: string }) {
  return (
    <div className={cn('shrink-0 rounded-[15%/7%] border border-border/60 bg-background p-[7px] shadow-modal', className)}>
      <div className="overflow-hidden rounded-[12%/5.5%] border border-border/50 bg-background" style={{ aspectRatio: '1206 / 2622' }}>
        <picture>
          <source srcSet={dark} media="(prefers-color-scheme: dark)" />
          <img src={light} alt={alt} loading="lazy" decoding="async" className="block h-full w-full object-cover object-top" />
        </picture>
      </div>
    </div>
  )
}
