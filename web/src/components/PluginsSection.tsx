import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Split, ThemedShot, Title } from './ui'
import { useCopy } from '../lib/i18n'
import pluginsLight from '../assets/shots/plugins-light.webp'
import pluginsDark from '../assets/shots/plugins-dark.webp'

const COPY = {
  en: {
    eyebrow: 'Plugins',
    titleA: 'Connect a tool once. ',
    titleB: 'Every agent can use it.',
    lead: 'Plugins bundle MCP servers, skills and sign-in into one install. Operon handles the OAuth and passes the tools to whichever agent you are talking to.',
    alt: 'Operon plugin marketplace with Linear, Slack, GitHub, Notion, Figma and more',
    features: [
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
    ],
  },
  zh: {
    eyebrow: '插件',
    titleA: '工具只连一次，',
    titleB: '所有 Agent 都能用。',
    lead: '插件把 MCP 服务器、Skills 和登录打包成一次安装。OAuth 由 Operon 处理，工具会交给你正在对话的那个 Agent。',
    alt: 'Operon 插件市场，包含 Linear、Slack、GitHub、Notion、Figma 等',
    features: [
      {
        title: '登录一次就够',
        desc: 'GitHub、Linear、Slack、Notion 连一次，所有 Agent 都能用——Claude Code、Codex、OpenCode 等等，不只是 Operon。',
      },
      {
        title: '开箱即用的市场',
        desc: 'Operon 自己的目录和 OpenAI 的插件放在一起浏览，一键安装。只列出你当前版本能跑的插件。',
      },
      {
        title: 'Skills 一并带上',
        desc: '插件自带的 Skills 会按每个 Agent 期望的方式装到位。',
      },
      {
        title: 'MCP 免配置',
        desc: '插件的 MCP 服务器会在每个 Agent 启动时交给它。设置页能看到每个插件加了什么，过期的 token 会自动刷新。',
      },
    ],
  },
}

export function PluginsSection() {
  const t = useCopy(COPY)

  return (
    <Section id="plugins" tone="sidebar">
      <Reveal>
        <Split
          reverse
          copy={
            <>
              <Eyebrow>{t.eyebrow}</Eyebrow>
              <Title>
                {t.titleA}<Muted>{t.titleB}</Muted>
              </Title>
              <Lead>{t.lead}</Lead>
              <div className="mt-8">
                <FeatureList items={t.features} />
              </div>
            </>
          }
          visual={<ThemedShot light={pluginsLight} dark={pluginsDark} alt={t.alt} aspect="940 / 900" />}
        />
      </Reveal>
    </Section>
  )
}
