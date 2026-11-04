import { Reveal } from './Reveal'
import { Eyebrow, FeatureList, Lead, Muted, Section, Split, Title } from './ui'
import { cn } from '../lib/styles'
import { useCopy } from '../lib/i18n'
import boardLight from '../assets/shots/phone-board-light.webp'
import boardDark from '../assets/shots/phone-board-dark.webp'
import chatLight from '../assets/shots/phone-chat-light.webp'
import chatDark from '../assets/shots/phone-chat-dark.webp'
import diffLight from '../assets/shots/phone-diff-light.webp'
import diffDark from '../assets/shots/phone-diff-dark.webp'

const COPY = {
  en: {
    eyebrow: 'Mobile and web',
    titleA: 'Away from your desk. ',
    titleB: 'Still in charge.',
    lead: 'Pair your phone or open the web app and pick up exactly where the desktop is — answer an approval on the bus, check a diff in bed, ask the assistant how things went.',
    alts: {
      board: 'Operon on iPhone: tasks grouped by status, one of them a spec that agents are still designing',
      chat: 'A Codex conversation on iPhone that added a CSV export, ending with the card of files it edited',
      diff: 'The diff of src/server.ts from that conversation, on iPhone',
    },
    features: [
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
    ],
  },
  zh: {
    eyebrow: '移动端与网页',
    titleA: '离开工位，',
    titleB: '照样掌控全局。',
    lead: '配对手机或打开网页版，就能从桌面端停下的地方接着来——在公交上批一个审批，躺床上看一眼 diff，问问助理事情进展如何。',
    alts: {
      board: 'iPhone 上的 Operon：任务按状态分组，其中一个是 Agent 还在设计中的 Spec',
      chat: 'iPhone 上一段新增 CSV 导出的 Codex 对话，结尾是它改动的文件卡片',
      diff: 'iPhone 上查看那段对话里 src/server.ts 的 diff',
    },
    features: [
      {
        title: '原生 iOS 和 Android 应用',
        desc: '原生 tab 栏、导航和底部弹层。iOS 版已上架 App Store；Android 版可从本站下载签名 APK 安装。',
      },
      {
        title: '完整的网页版',
        desc: '任意浏览器里都是和桌面端一样的界面，会话、diff、审批和工具都相同。',
      },
      {
        title: '端到端加密',
        desc: '每台设备与你的 Mac 之间的内容都经过加密。新手机和新浏览器只能在桌面端批准接入。',
      },
      {
        title: '离开电脑才推送',
        desc: '你在电脑前时通知先不发，离开后才送达。快速回复还可以用 Telegram 和 Slack 机器人。',
      },
    ],
  },
}

export function MobileSection() {
  const t = useCopy(COPY)

  return (
    <Section id="mobile">
      <Reveal>
        <Split
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
          visual={
            /* Left to right, the trip a phone check takes: the board, the
               conversation that finished, the diff it left. The middle one leads;
               on a phone-width page only it is shown. */
            <div className="flex items-start justify-center gap-3 sm:gap-4">
              <PhoneMock
                light={boardLight}
                dark={boardDark}
                alt={t.alts.board}
                className="mt-10 hidden w-[180px] sm:block lg:w-[190px]"
              />
              <PhoneMock
                light={chatLight}
                dark={chatDark}
                alt={t.alts.chat}
                className="relative z-10 w-[240px] sm:w-[210px] lg:w-[220px]"
              />
              <PhoneMock
                light={diffLight}
                dark={diffDark}
                alt={t.alts.diff}
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
