import { useState, useEffect, useRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router'

// English docs
import gettingStartedEn from '@doc/getting-started.md?raw'
import chatEn from '@doc/chat.md?raw'
import browserEn from '@doc/browser.md?raw'
import chromeEn from '@doc/chrome.md?raw'
import computerUseEn from '@doc/computer-use.md?raw'
import terminalEn from '@doc/terminal.md?raw'
import gitEn from '@doc/git.md?raw'
import tasksEn from '@doc/tasks.md?raw'
import sddEn from '@doc/sdd.md?raw'
import workflowEn from '@doc/workflow.md?raw'
import memoryEn from '@doc/memory.md?raw'
import externalAgentsEn from '@doc/external-agents.md?raw'
import mcpServersEn from '@doc/mcp-servers.md?raw'
import providersEn from '@doc/providers.md?raw'
import skillsEn from '@doc/skills.md?raw'
import pluginsEn from '@doc/plugins.md?raw'
import cronjobEn from '@doc/cronjob.md?raw'
import channelsEn from '@doc/channels.md?raw'
import imPlatformsEn from '@doc/im-platforms.md?raw'
import mobileEn from '@doc/mobile.md?raw'
import remoteAccessEn from '@doc/remote-access.md?raw'
import githubEn from '@doc/github.md?raw'
import notificationsEn from '@doc/notifications.md?raw'
import configurationEn from '@doc/configuration.md?raw'
import environmentEn from '@doc/environment.md?raw'
import appearanceEn from '@doc/appearance.md?raw'

// Chinese docs
import gettingStartedZh from '@doc/zh/getting-started.md?raw'
import chatZh from '@doc/zh/chat.md?raw'
import browserZh from '@doc/zh/browser.md?raw'
import chromeZh from '@doc/zh/chrome.md?raw'
import computerUseZh from '@doc/zh/computer-use.md?raw'
import terminalZh from '@doc/zh/terminal.md?raw'
import gitZh from '@doc/zh/git.md?raw'
import tasksZh from '@doc/zh/tasks.md?raw'
import sddZh from '@doc/zh/sdd.md?raw'
import workflowZh from '@doc/zh/workflow.md?raw'
import memoryZh from '@doc/zh/memory.md?raw'
import externalAgentsZh from '@doc/zh/external-agents.md?raw'
import mcpServersZh from '@doc/zh/mcp-servers.md?raw'
import providersZh from '@doc/zh/providers.md?raw'
import skillsZh from '@doc/zh/skills.md?raw'
import pluginsZh from '@doc/zh/plugins.md?raw'
import cronjobZh from '@doc/zh/cronjob.md?raw'
import channelsZh from '@doc/zh/channels.md?raw'
import imPlatformsZh from '@doc/zh/im-platforms.md?raw'
import mobileZh from '@doc/zh/mobile.md?raw'
import remoteAccessZh from '@doc/zh/remote-access.md?raw'
import githubZh from '@doc/zh/github.md?raw'
import notificationsZh from '@doc/zh/notifications.md?raw'
import configurationZh from '@doc/zh/configuration.md?raw'
import environmentZh from '@doc/zh/environment.md?raw'
import appearanceZh from '@doc/zh/appearance.md?raw'

type Lang = 'en' | 'zh'

interface DocSection {
  slug: string
  title: Record<Lang, string>
  content: Record<Lang, string>
}

const docs: DocSection[] = [
  { slug: 'getting-started', title: { en: 'Getting Started', zh: '快速上手' }, content: { en: gettingStartedEn, zh: gettingStartedZh } },
  { slug: 'chat', title: { en: 'Chat', zh: '聊天' }, content: { en: chatEn, zh: chatZh } },
  { slug: 'browser', title: { en: 'Browser', zh: '浏览器' }, content: { en: browserEn, zh: browserZh } },
  { slug: 'chrome', title: { en: 'Chrome', zh: 'Chrome' }, content: { en: chromeEn, zh: chromeZh } },
  { slug: 'computer-use', title: { en: 'Computer Use', zh: 'Computer Use' }, content: { en: computerUseEn, zh: computerUseZh } },
  { slug: 'terminal', title: { en: 'Terminal', zh: '终端' }, content: { en: terminalEn, zh: terminalZh } },
  { slug: 'git', title: { en: 'Git', zh: 'Git' }, content: { en: gitEn, zh: gitZh } },
  { slug: 'channels', title: { en: 'Channels', zh: '频道' }, content: { en: channelsEn, zh: channelsZh } },
  { slug: 'tasks', title: { en: 'Tasks', zh: '任务' }, content: { en: tasksEn, zh: tasksZh } },
  { slug: 'sdd', title: { en: 'Spec-Driven Development', zh: '规格驱动开发' }, content: { en: sddEn, zh: sddZh } },
  { slug: 'workflow', title: { en: 'Workflow', zh: '工作流' }, content: { en: workflowEn, zh: workflowZh } },
  { slug: 'memory', title: { en: 'Memory', zh: '记忆' }, content: { en: memoryEn, zh: memoryZh } },
  { slug: 'external-agents', title: { en: 'External Agents', zh: '外部 Agent' }, content: { en: externalAgentsEn, zh: externalAgentsZh } },
  { slug: 'mcp-servers', title: { en: 'MCP Servers', zh: 'MCP 服务器' }, content: { en: mcpServersEn, zh: mcpServersZh } },
  { slug: 'providers', title: { en: 'AI Providers', zh: 'AI Providers' }, content: { en: providersEn, zh: providersZh } },
  { slug: 'skills', title: { en: 'Skills', zh: '技能' }, content: { en: skillsEn, zh: skillsZh } },
  { slug: 'plugins', title: { en: 'Plugins', zh: '插件' }, content: { en: pluginsEn, zh: pluginsZh } },
  { slug: 'cronjob', title: { en: 'Cronjob', zh: '定时任务' }, content: { en: cronjobEn, zh: cronjobZh } },
  { slug: 'mobile', title: { en: 'Mobile', zh: '移动端' }, content: { en: mobileEn, zh: mobileZh } },
  { slug: 'remote-access', title: { en: 'Remote Web Access', zh: '远程网页访问' }, content: { en: remoteAccessEn, zh: remoteAccessZh } },
  { slug: 'im-platforms', title: { en: 'IM Platforms', zh: 'IM 平台集成' }, content: { en: imPlatformsEn, zh: imPlatformsZh } },
  { slug: 'github', title: { en: 'GitHub', zh: 'GitHub' }, content: { en: githubEn, zh: githubZh } },
  { slug: 'notifications', title: { en: 'Notifications', zh: '通知' }, content: { en: notificationsEn, zh: notificationsZh } },
  { slug: 'configuration', title: { en: 'Configuration Files', zh: '配置文件' }, content: { en: configurationEn, zh: configurationZh } },
  { slug: 'environment', title: { en: 'Environment & Logs', zh: '环境与日志' }, content: { en: environmentEn, zh: environmentZh } },
  { slug: 'appearance', title: { en: 'Appearance', zh: '外观' }, content: { en: appearanceEn, zh: appearanceZh } },
]

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

function extractHeadings(md: string): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = []
  for (const line of md.split('\n')) {
    const match = line.match(/^(#{1,3})\s+(.+)/)
    if (match) {
      const level = match[1].length
      const text = match[2].trim()
      headings.push({ id: slugify(text), text, level })
    }
  }
  return headings
}

export function Docs() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem('docs-lang')
    return (saved === 'zh' ? 'zh' : 'en') as Lang
  })
  const [activeSlug, setActiveSlug] = useState(docs[0].slug)
  const [activeHeading, setActiveHeading] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const activeDoc = docs.find((d) => d.slug === activeSlug)!
  const activeContent = activeDoc.content[lang]
  const headings = useMemo(() => extractHeadings(activeContent), [activeContent])

  const toggleLang = () => {
    const next = lang === 'en' ? 'zh' : 'en'
    setLang(next)
    localStorage.setItem('docs-lang', next)
  }

  useEffect(() => {
    const container = contentRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveHeading(entry.target.id)
          }
        }
      },
      { root: container, rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    )

    const headingEls = container.querySelectorAll('h1, h2, h3')
    headingEls.forEach((el) => observer.observe(el))

    return () => observer.disconnect()
  }, [activeContent])

  useEffect(() => {
    contentRef.current?.scrollTo(0, 0)
    const frame = requestAnimationFrame(() => setActiveHeading(''))
    return () => cancelAnimationFrame(frame)
  }, [activeSlug, lang])

  const scrollToHeading = (id: string) => {
    const el = contentRef.current?.querySelector(`#${CSS.escape(id)}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    // Fixed viewport height, not minHeight: the three panes scroll on their own.
    // With minHeight the tall chapter list stretches the row past the viewport,
    // the document itself starts scrolling, and the content pane's bottom edge
    // exposes empty background below it.
    <div style={{ height: '100dvh', overflow: 'hidden', background: '#000', color: '#fff', display: 'flex', flexDirection: 'column' }}>
      {/* Navbar */}
      <nav
        style={{
          flexShrink: 0,
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          height: 56,
          background: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link
            to="/"
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '0.06em',
              color: 'rgba(255,255,255,0.9)',
              fontFamily: "'General Sans', sans-serif",
              textTransform: 'uppercase',
              textDecoration: 'none',
            }}
          >
            OPERON
          </Link>
          <span style={{ color: 'rgba(255,255,255,0.15)' }}>/</span>
          <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', fontWeight: 400 }}>Docs</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Language toggle */}
          <button
            onClick={toggleLang}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 12px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.6)',
              fontSize: 13,
              fontWeight: 400,
              cursor: 'pointer',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
              e.currentTarget.style.color = 'rgba(255,255,255,0.8)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
              e.currentTarget.style.color = 'rgba(255,255,255,0.6)'
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            {lang === 'en' ? 'EN' : 'ZH'}
          </button>

          {/* Mobile menu toggle */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            style={{
              display: 'none',
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: 4,
            }}
            className="docs-mobile-toggle"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
        </div>
      </nav>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
        {/* Left sidebar - chapters */}
        <aside
          className={`docs-sidebar ${sidebarOpen ? 'open' : ''}`}
          style={{
            width: 200,
            minWidth: 200,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            padding: '24px 0',
            overflowY: 'auto',
            minHeight: 0,
          }}
        >
          <div style={{ padding: '0 16px 12px', fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Documentation
          </div>
          {docs.map((doc) => (
            <button
              key={doc.slug}
              onClick={() => {
                setActiveSlug(doc.slug)
                setSidebarOpen(false)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 16px',
                fontSize: 15,
                fontWeight: activeSlug === doc.slug ? 500 : 400,
                color: activeSlug === doc.slug ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)',
                background: activeSlug === doc.slug ? 'rgba(255,255,255,0.05)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.15s',
                borderLeft: activeSlug === doc.slug ? '2px solid rgba(255,255,255,0.3)' : '2px solid transparent',
              }}
            >
              {doc.title[lang]}
            </button>
          ))}
        </aside>

        {/* Main content */}
        <main
          ref={contentRef}
          className="docs-content"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto',
            padding: '40px 56px',
          }}
        >
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <div className="docs-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => {
                    const text = String(children)
                    const id = slugify(text)
                    return <h1 id={id} style={{ fontSize: 36, fontWeight: 600, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em', marginBottom: 8, marginTop: 0, lineHeight: 1.3 }}>{children}</h1>
                  },
                  h2: ({ children }) => {
                    const text = String(children)
                    const id = slugify(text)
                    return <h2 id={id} style={{ fontSize: 22, fontWeight: 600, color: 'rgba(255,255,255,0.85)', marginTop: 48, marginBottom: 16, paddingTop: 24, borderTop: '1px solid rgba(255,255,255,0.06)', lineHeight: 1.4 }}>{children}</h2>
                  },
                  h3: ({ children }) => {
                    const text = String(children)
                    const id = slugify(text)
                    return <h3 id={id} style={{ fontSize: 17, fontWeight: 600, color: 'rgba(255,255,255,0.88)', marginTop: 32, marginBottom: 12, lineHeight: 1.4 }}>{children}</h3>
                  },
                  p: ({ children }) => (
                    <p style={{ fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.7)', marginBottom: 16, fontWeight: 400 }}>{children}</p>
                  ),
                  // listStyleType is set explicitly: the global reset strips markers,
                  // which silently turns numbered steps into indented prose.
                  ul: ({ children }) => (
                    <ul style={{ paddingLeft: 22, marginBottom: 16, listStyleType: 'disc' }}>{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol style={{ paddingLeft: 22, marginBottom: 16, listStyleType: 'decimal' }}>{children}</ol>
                  ),
                  li: ({ children }) => (
                    <li style={{ fontSize: 16, lineHeight: 1.8, color: 'rgba(255,255,255,0.7)', marginBottom: 4, fontWeight: 400 }}>{children}</li>
                  ),
                  strong: ({ children }) => (
                    <strong style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>{children}</strong>
                  ),
                  code: ({ children, className }) => {
                    const isBlock = className?.startsWith('language-')
                    if (isBlock) {
                      return (
                        <code
                          className={className}
                          style={{
                            display: 'block',
                            padding: '16px 20px',
                            background: 'rgba(255,255,255,0.03)',
                            borderRadius: 8,
                            border: '1px solid rgba(255,255,255,0.06)',
                            fontSize: 14,
                            lineHeight: 1.7,
                            color: 'rgba(255,255,255,0.75)',
                            overflowX: 'auto',
                            fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', monospace",
                          }}
                        >
                          {children}
                        </code>
                      )
                    }
                    return (
                      <code
                        style={{
                          padding: '2px 6px',
                          background: 'rgba(255,255,255,0.06)',
                          borderRadius: 4,
                          fontSize: 14,
                          color: 'rgba(255,255,255,0.8)',
                          fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', monospace",
                        }}
                      >
                        {children}
                      </code>
                    )
                  },
                  pre: ({ children }) => (
                    <pre style={{ marginBottom: 16, overflowX: 'auto' }}>{children}</pre>
                  ),
                  table: ({ children }) => (
                    <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                      <table
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          fontSize: 14,
                        }}
                      >
                        {children}
                      </table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>{children}</thead>
                  ),
                  th: ({ children }) => (
                    <th
                      style={{
                        padding: '10px 12px',
                        textAlign: 'left',
                        fontWeight: 500,
                        color: 'rgba(255,255,255,0.75)',
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td
                      style={{
                        padding: '10px 12px',
                        color: 'rgba(255,255,255,0.65)',
                        borderTop: '1px solid rgba(255,255,255,0.04)',
                        fontSize: 14,
                      }}
                    >
                      {children}
                    </td>
                  ),
                  a: ({ href, children }) => {
                    // Docs live on a single route; cross-references are bare slugs
                    // ("channels") and in-page anchors ("#agent-automation"). Both
                    // have to be handled here — following them as real URLs would
                    // navigate to routes that don't exist.
                    const linkStyle = { color: 'rgba(140,180,255,0.85)', textDecoration: 'underline', textUnderlineOffset: 3 }
                    const target = href ?? ''
                    const isAnchor = target.startsWith('#')
                    const linkedDoc = docs.find((d) => d.slug === target)

                    if (isAnchor || linkedDoc) {
                      return (
                        <a
                          href={target}
                          onClick={(e) => {
                            e.preventDefault()
                            // Switching slug already scrolls the pane back to the top.
                            if (linkedDoc) setActiveSlug(linkedDoc.slug)
                            else scrollToHeading(decodeURIComponent(target.slice(1)))
                          }}
                          style={linkStyle}
                        >
                          {children}
                        </a>
                      )
                    }

                    return (
                      <a href={target} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                        {children}
                      </a>
                    )
                  },
                  hr: () => (
                    <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)', margin: '32px 0' }} />
                  ),
                  blockquote: ({ children }) => (
                    <blockquote
                      style={{
                        borderLeft: '2px solid rgba(255,255,255,0.1)',
                        paddingLeft: 16,
                        margin: '16px 0',
                        color: 'rgba(255,255,255,0.55)',
                      }}
                    >
                      {children}
                    </blockquote>
                  ),
                }}
              >
                {activeContent}
              </ReactMarkdown>
            </div>
          </div>
        </main>

        {/* Right sidebar - table of contents */}
        <aside
          className="docs-toc"
          style={{
            width: 200,
            minWidth: 200,
            padding: '24px 16px',
            overflowY: 'auto',
            minHeight: 0,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
            {lang === 'en' ? 'On this page' : 'On this page'}
          </div>
          {headings.map((h) => (
            <button
              key={h.id}
              onClick={() => scrollToHeading(h.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '4px 0',
                paddingLeft: h.level === 1 ? 0 : h.level === 2 ? 8 : 16,
                fontSize: 13,
                fontWeight: activeHeading === h.id ? 500 : 400,
                color: activeHeading === h.id ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                transition: 'color 0.15s',
                lineHeight: 1.6,
              }}
            >
              {h.text}
            </button>
          ))}
        </aside>
      </div>

      <style>{`
        .docs-mobile-toggle {
          display: none !important;
        }
        @media (max-width: 900px) {
          .docs-mobile-toggle {
            display: block !important;
          }
          .docs-sidebar {
            position: fixed;
            top: 56px;
            left: 0;
            bottom: 0;
            z-index: 40;
            transform: translateX(-100%);
            transition: transform 0.2s ease;
            background: rgba(0,0,0,0.95) !important;
            backdrop-filter: blur(20px);
          }
          .docs-sidebar.open {
            transform: translateX(0);
          }
          .docs-toc {
            display: none !important;
          }
          .docs-content {
            padding: 24px 20px !important;
          }
        }
        @media (max-width: 1100px) {
          .docs-toc {
            display: none !important;
          }
        }
      `}</style>
    </div>
  )
}
