export function Privacy() {
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
          Privacy Policy
        </h1>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.25)', marginBottom: 48 }}>
          Last updated: August 10, 2026
        </p>

        <Section title="1. Introduction">
          Operon ("we", "our", "us") is a desktop application for working with AI coding agents,
          together with optional companion software: the Operon Browser Use Chrome extension, and
          the Operon mobile and browser clients, which reach the desktop app on your own machine
          remotely. This Privacy Policy explains how we handle information when you use Operon and
          related components.
        </Section>

        <Section title="2. Information We Collect">
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>Local Data First.</strong> Operon runs
          on your local machine. Conversations, files, memories, workflow configurations, and
          browser-automation state remain on your device unless you explicitly send content to a
          third-party service you configure (for example an AI provider). We do not store any of it.
          <br /><br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>
            Account and Devices (mobile and web clients only).
          </strong>{' '}
          If you use the Operon mobile app or the browser client to reach your own machine, we
          operate a broker service that connects the two, and it keeps a small amount of data so it
          knows which machines are yours:
          <br />
          <List
            items={[
              'An opaque account identifier from the sign-in provider you choose (GitHub or Apple). We do not collect or store your email address or your name.',
              'The generated id and the label of each machine you pair, so it can be listed and reached.',
              'A push notification token, if you enable notifications, issued by Apple or Google and used only to deliver notifications to that device. It is deleted when the device stops accepting them.',
            ]}
          />
          <br />
          Your conversations, code, files, terminal output and diffs pass through the broker as
          end-to-end encrypted content. They are not written to disk and not logged. Requests are recorded as
          ordinary web-server access logs (timestamp, path, response status) used to operate the
          service, and those are not linked to your content. Deleting your account removes
          everything listed above.
          <br /><br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>Desktop-only use.</strong> If you never
          sign in to the mobile or web client, none of the above applies — nothing is sent to us at
          all.
          <br /><br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>Third-Party API Calls.</strong> When
          you use AI adapters (Claude Code, Codex, Gemini CLI, OpenCode, or Custom providers), your
          prompts and code are sent directly from your machine to the respective API providers. We
          do not intercept, proxy, or store these communications. Each provider's own privacy policy
          governs how they handle your data.
          <br /><br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>Analytics.</strong> We use PostHog to
          collect anonymous usage analytics — in the desktop app and in the mobile and browser
          clients alike. This covers which screens were opened and which actions were taken (for
          example that a conversation was started, or which provider was selected), masked
          interaction diagnostics such as clicks, unresponsive clicks and heatmaps, web
          performance metrics, plus crash reports containing the error message and stack trace.
          Page URLs never include query parameters or fragments, and automatically collected
          element text and attributes are removed before events are sent. Analytics does not
          include your code, prompts, conversations, file contents, clipboard contents, console
          logs, session replays, or API keys.
          <br />
          <br />
          The analytics identifier is generated on your device and is never joined to your Operon
          account, so this data is not linked to your identity. You can turn analytics off at any
          time — in the mobile app under More → Privacy. Turning it off also discards the stored
          identifier.
        </Section>

        <Section title="3. Chrome Extension (Operon Browser Use)">
          The optional Chrome extension connects your browser to the Operon desktop app so agents
          can perform browser tasks you request (for example open tabs, navigate pages, inspect
          page content, search history when asked, or handle downloads related to a task).
          <br /><br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>How it works.</strong> The extension
          communicates with a native messaging host installed by the Operon desktop application on
          your computer. Traffic stays on your machine between Chrome and Operon. The extension is
          a bridge; it is not useful without the desktop app.
          <br /><br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>What it may access.</strong> Only in
          service of tasks you start in Operon, the extension may use browser capabilities such as
          tabs and navigation, page content (including via the Chrome debugger), scripting for a
          visual cursor overlay, browsing history when a task needs it, downloads, tab groups, and
          local extension storage for connection status. It requests broad site access because
          agents may need to visit URLs you ask them to work with—not to inject ads or track you
          across the web for marketing.
          <br /><br />
          <strong style={{ color: 'rgba(255,255,255,0.7)' }}>What we do not do.</strong> The
          extension does not sell your browsing data, show third-party ads, or send your browsing
          history or page content to Operon-operated servers as part of the bridge. Page content
          and task context that leave your machine only do so if you run an AI or other provider
          you configured in Operon, under that provider's terms.
          <br /><br />
          You can remove the extension at any time from Chrome's extension settings, and you can
          disable Browser Use in Operon settings to unregister the native host.
        </Section>

        <Section title="4. How Your Data Is Stored">
          Apart from the account and device records described in section 2, all application data is
          stored locally on your device:
          <br /><br />
          <List items={[
            'Chat history and conversations are stored in a local SQLite database.',
            'Memory and embeddings are stored in local files under your home directory.',
            'Workflow configurations, skills, and scheduled tasks are stored locally.',
            'API keys and provider credentials are stored in your local configuration files.',
            'Chrome extension connection state may be stored in Chrome local storage on your device.',
          ]} />
          Anonymous usage analytics collected by PostHog are processed on PostHog's servers in
          accordance with their privacy policy. No personally identifiable information, code, or
          conversation content is included in analytics data.
          <br /><br />
          We recommend securing your device and configuration files to protect your API keys and
          conversation data.
        </Section>

        <Section title="5. Data Sharing">
          We do not sell, rent, or share your data with third parties for advertising or data
          brokerage. The broker described in section 2 carries encrypted traffic between your own devices
          without storing its contents; we do not operate a cloud service that receives and keeps
          your chats or browsing data.
          <br /><br />
          When you use third-party AI providers or other integrations you configure, your
          interactions are governed by their respective privacy policies. We encourage you to
          review those policies for any service you enable in Operon.
        </Section>

        <Section title="6. Data Retention">
          All data remains on your device until you delete it. You can clear your conversation
          history, memories, and all stored data at any time through the application settings or
          by removing the local data directory. Uninstalling the Chrome extension removes its
          local extension storage from Chrome.
        </Section>

        <Section title="7. Security">
          We implement reasonable security measures in the application, including:
          <br /><br />
          <List items={[
            'Permission control system for file access and command execution.',
            'Approval gates for destructive operations.',
            'Local-only storage to minimize attack surface.',
            'Native messaging limited to the Operon desktop host and known extension IDs.',
          ]} />
          However, no software is completely secure. You are responsible for maintaining the
          security of your device and your API keys.
        </Section>

        <Section title="8. Children's Privacy">
          Operon is not intended for use by individuals under the age of 13. We do not knowingly
          collect information from children.
        </Section>

        <Section title="9. Changes to This Policy">
          We may update this Privacy Policy from time to time. Changes will be reflected in the
          "Last updated" date above. Continued use of Operon after changes constitutes acceptance
          of the updated policy.
        </Section>

        <Section title="10. Contact">
          If you have questions about this Privacy Policy, please open an issue on our GitHub
          repository at https://github.com/Nickqiaoo/Operon.
        </Section>
      </div>
    </div>
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

function List({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }}>
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 6 }}>{item}</li>
      ))}
    </ul>
  )
}
