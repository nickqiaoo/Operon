import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Split, Title } from './ui'
import phoneLight from '../assets/shots/phone-light.webp'
import phoneDark from '../assets/shots/phone-dark.webp'

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
    <Section id="mobile" tone="sidebar">
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
            <div className="flex justify-center">
              <PhoneMock />
            </div>
          }
        />
      </Reveal>
    </Section>
  )
}

function PhoneMock() {
  return (
    <div className="w-[290px] rounded-[44px] border border-border/60 bg-background p-2.5 shadow-modal">
      <div className="overflow-hidden rounded-[36px] border border-border/50 bg-background" style={{ aspectRatio: '1206 / 2622' }}>
        <picture>
          <source srcSet={phoneDark} media="(prefers-color-scheme: dark)" />
          <img
            src={phoneLight}
            alt="Operon on iPhone: the task list grouped by status, with the native tab bar"
            loading="lazy"
            decoding="async"
            className="block h-full w-full object-cover object-top"
          />
        </picture>
      </div>
    </div>
  )
}
