import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Split, ThemedShot, Title } from './ui'
import pluginsLight from '../assets/shots/plugins-light.webp'
import pluginsDark from '../assets/shots/plugins-dark.webp'

const FEATURES = [
  {
    title: 'Sign in once',
    desc: 'Connect GitHub, Linear, Slack or Notion one time and every agent can use it — Claude Code, Codex, OpenCode and the rest, not just Operon.',
  },
  {
    title: 'A marketplace that just works',
    desc: 'Browse Operon’s catalogue alongside OpenAI’s plugins and install with a click. Only plugins that run on your version are listed.',
  },
  {
    title: 'Skills come along',
    desc: 'Plugins bring their skills, installed for each agent the way that agent expects to find them.',
  },
  {
    title: 'MCP without the config',
    desc: 'A plugin’s MCP servers are handed to each agent when it starts. Settings shows what every plugin added, and expired tokens refresh on their own.',
  },
]

export function PluginsSection() {
  return (
    <Section id="plugins">
      <Reveal>
        <Split
          reverse
          copy={
            <>
              <Eyebrow>Plugins</Eyebrow>
              <Title>
                Connect a tool once. <Muted>Every agent can use it.</Muted>
              </Title>
              <Lead>
                Plugins bundle MCP servers, skills and sign-in into one install. Operon handles the OAuth and
                passes the tools to whichever agent you are talking to.
              </Lead>
              <div className="mt-8">
                <FeatureList items={FEATURES} />
              </div>
            </>
          }
          visual={
            <ThemedShot
              light={pluginsLight}
              dark={pluginsDark}
              alt="Operon plugin marketplace with Linear, Slack, GitHub, Notion, Figma and more"
              aspect="940 / 900"
            />
          }
        />
      </Reveal>
    </Section>
  )
}
