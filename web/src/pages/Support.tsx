/**
 * Support page, served at /support.
 *
 * Exists because the App Store and Play listings both require a support URL, and
 * a reviewer will actually open it. It has to answer "what is this and how do I
 * get help" to someone with no account, so it stays static — no auth, no fetch,
 * nothing that can fail. It is also the page people reach when something else is
 * already broken.
 *
 * Kept on the marketing site rather than in the app, since app.operon.chatcode.top
 * opens onto a sign-in screen.
 */
export function Support() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#000',
        color: '#fff',
        padding: '120px 40px 80px',
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1
          style={{
            fontSize: 40,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.92)',
            letterSpacing: '-0.025em',
            marginBottom: 12,
          }}
        >
          Support
        </h1>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.25)', marginBottom: 48 }}>
          Operon — help, common questions, and how to reach us
        </p>

        <Section title="What Operon is">
          Operon runs on your own computer, next to your code and your AI coding agents. The mobile
          and web clients are remote controls for it: your repositories, keys and conversations stay
          on your machine, and the app connects to it over an encrypted tunnel so you can keep
          working away from your desk.
          <br />
          <br />
          The mobile app is a client, not a standalone tool. Without the Operon desktop app running
          and signed in on a machine of yours, there is nothing for it to control.
        </Section>

        <Section title="Getting help">
          Open an issue at{' '}
          <Link href="https://github.com/Nickqiaoo/Operon">github.com/Nickqiaoo/Operon</Link>, or
          email <Link href="mailto:support@chatcode.top">support@chatcode.top</Link>. Describing what
          you were doing and roughly when is usually enough to track down the matching request.
        </Section>

        <Section title="Setting up">
          Install the desktop app on the computer where your code lives, sign in, and connect it.
          The full walkthrough is in the <Link href="/docs">documentation</Link>. Once a machine is
          connected it appears in the mobile and web clients under the same account.
        </Section>

        <Section title="Common questions">
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>The machine list is empty.</strong>{' '}
          Nothing has been paired to this account yet. Open the desktop app on your computer and
          sign in there with the same provider. Signing in with GitHub and signing in with Apple
          create two separate accounts by design, so a machine paired under one will not show up
          under the other.
          <br />
          <br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>A machine shows as offline.</strong>{' '}
          The desktop app is closed, the computer is asleep, or it has no network. It reconnects on
          its own once it is running again.
          <br />
          <br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>Notifications never arrive.</strong>{' '}
          Only things actually waiting on you are pushed — a question you need to answer, or work
          that wants your review. Ordinary replies are not, by design, so that notifications stay
          worth reading.
          <br />
          <br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>
            Sending a message fails on the phone but works on the desktop.
          </strong>{' '}
          The tunnel reaches your machine but the agent there cannot run — usually a provider that
          is not installed or not signed in on that computer. Check it from the desktop app first.
        </Section>

        <Section title="Deleting your account">
          In the app under More → Delete account, or at{' '}
          <Link href="https://app.operon.chatcode.top/delete-account">
            app.operon.chatcode.top/delete-account
          </Link>
          . This removes your account, every paired machine, and any device registered for
          notifications. Your projects and conversations are not affected — they were never on our
          servers.
        </Section>

        <Section title="Privacy">
          What is and is not collected is set out in the <Link href="/privacy">Privacy Policy</Link>.
          The short version: no email address is collected, and your code and conversations never
          reach our servers.
        </Section>
      </div>
    </div>
  )
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith('http') || href.startsWith('mailto:')
  return (
    <a
      href={href}
      {...(external && href.startsWith('http')
        ? { target: '_blank', rel: 'noopener noreferrer' }
        : {})}
      style={{ color: 'rgba(255,255,255,0.75)', textDecoration: 'underline' }}
    >
      {children}
    </a>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 40 }}>
      <h2
        style={{
          fontSize: 20,
          fontWeight: 600,
          color: 'rgba(255,255,255,0.85)',
          marginBottom: 16,
        }}
      >
        {title}
      </h2>
      <div style={{ fontSize: 15, lineHeight: 1.8, color: 'rgba(255,255,255,0.4)', fontWeight: 300 }}>
        {children}
      </div>
    </div>
  )
}
