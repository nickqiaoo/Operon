import { useState } from 'react'
import { useIsMobile } from '../hooks/useIsMobile'
import { useIsCompactViewport } from '../hooks/useIsCompactViewport'
import claudeIcon from '../assets/claude.svg'
import openaiIcon from '../assets/openai.svg'
import googleIcon from '../assets/google.svg'
import opencodeIcon from '../assets/opencode.svg'
import kimiIcon from '../assets/kimi.svg'
import operonIcon from '../assets/operon-white.svg'
import copilotIcon from '../assets/copilot.svg'
import cursorIcon from '../assets/cursor.svg'

interface Adapter {
  id: string
  name: string
  icon: string
  label: string
  description: string
  features: string[]
  accent: string
  /** Operon's own built-in agent — distinguished from CLI adapters with a badge. */
  native?: boolean
}

const adapters: Adapter[] = [
  {
    id: 'operon',
    name: 'Operon Agent',
    icon: operonIcon,
    label: 'Native · Multi-provider',
    native: true,
    description:
      "Operon's own agent — not a wrapper around someone else's CLI. An AI SDK agent loop that aggregates 8+ model providers behind a single built-in tool system, with skills, MCP, and memory baked in. Mix and match models without leaving Operon.",
    features: [
      'Aggregates 8+ providers',
      'Built-in tool system',
      'Skills & MCP support',
      'Memory built in',
    ],
    accent: '#ec4899',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: claudeIcon,
    label: 'Anthropic',
    description:
      'Deep integration with Claude Code CLI. Multiple permission modes for safe autonomous coding, adjustable thinking levels, and rich UI for subagent, question tools, and slash commands. Switch models and modes mid-conversation for a CLI-like experience.',
    features: [
      'Adjustable thinking levels',
      'Subagent & question tool UI',
      'Slash command support',
      'Real-time model & mode switching, CLI-consistent',
    ],
    accent: '#d97706',
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: openaiIcon,
    label: 'OpenAI',
    description:
      'Built on Codex App Server with full session management. Plan mode for reviewing changes before execution, rich subagent UI rendering, and sandbox isolation for safe coding.',
    features: [
      'Codex App Server integration',
      'Plan mode support',
      'Fast mode support',
      'Usage quota monitoring',
      'Subagent UI rendering',
      'Sandbox isolation modes',
    ],
    accent: '#10b981',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    icon: googleIcon,
    label: 'Google',
    description:
      'Built from Gemini Core source code, fully compatible with all Gemini CLI capabilities. OAuth authentication, and rich UI rendering for subagent and all tool invocations.',
    features: [
      'Gemini Core source implementation',
      'Full Gemini CLI compatibility',
      'Configurable thinking budget',
      'OAuth & subagent support',
    ],
    accent: '#6366f1',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    icon: copilotIcon,
    label: 'GitHub',
    description:
      'Built on the Copilot SDK. Three modes — Interactive (per-action approval), Plan, and Autopilot (autonomous) — with configurable reasoning effort and a live, plan-specific model list.',
    features: [
      'Interactive · Plan · Autopilot',
      'Configurable reasoning effort',
      'Live plan-specific model list',
      'Rich tool UI rendering',
    ],
    accent: '#2f81f7',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: cursorIcon,
    label: 'Cursor',
    description:
      'Built on the cursor-agent CLI. Plan, Ask, and Agent modes, sandboxed execution, and a live model list (Composer, Codex, Opus, and more) pulled from your account.',
    features: [
      'Plan · Ask · Agent modes',
      'Sandboxed execution',
      'Live account model list',
      'Rich tool UI rendering',
    ],
    accent: '#64748b',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    icon: opencodeIcon,
    label: 'Open Source',
    description:
      'Built on OpenCode SDK with full feature parity. Multi-provider support for GLM, DeepSeek, and more, with rich UI rendering for all tool invocations.',
    features: [
      'OpenCode SDK integration',
      'Full OpenCode compatibility',
      'Rich tool UI rendering',
      'Multi-provider support',
    ],
    accent: '#8b5cf6',
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    icon: kimiIcon,
    label: 'Moonshot',
    description:
      "Coding agent built on Moonshot's Kimi model. Three modes — Default, Plan, and Full Access (auto-approves actions) — plus slash commands like /compact, with rich UI rendering for all tool calls.",
    features: [
      'Default · Plan · Full Access',
      'Slash commands (/compact)',
      'Rich tool UI rendering',
      'Streaming tool calls',
    ],
    accent: '#1f7a8c',
  },
]

const iconFilter = (adapterId: string) => (adapterId === 'opencode' || adapterId === 'operon' ? 'none' : 'invert(1)')

export function AdaptersSection() {
  const [activeIndex, setActiveIndex] = useState(0)
  const active = adapters[activeIndex]
  const mobile = useIsMobile()
  const compactViewport = useIsCompactViewport()
  const scrollableViewport = mobile || compactViewport

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {/* Background glow */}
      <div
        style={{
          position: 'absolute',
          width: 800,
          height: 800,
          borderRadius: '50%',
          top: '50%',
          left: '55%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: active.accent,
          opacity: 0.05,
          filter: 'blur(200px)',
          transition: 'background-color 0.6s',
          pointerEvents: 'none',
        }}
      />

      {/* Content */}
      <div
        data-scrollable
        style={{
          display: 'flex',
          flexDirection: mobile ? 'column' : 'row',
          alignItems: mobile ? 'stretch' : 'flex-start',
          gap: mobile ? 24 : 80,
          width: '90vw',
          maxWidth: 1400,
          ...(scrollableViewport
            ? {
                height: '100%',
                paddingTop: mobile ? 72 : 96,
                paddingBottom: mobile ? 24 : 56,
                overflow: 'auto',
              }
            : { minHeight: 480 }),
        }}
      >
        {/* Left: heading + adapter tabs */}
        <div style={{ width: mobile ? '100%' : 380, flexShrink: 0 }}>
          <p
            style={{
              fontSize: 12,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.3)',
              marginBottom: mobile ? 10 : 16,
              fontWeight: 500,
            }}
          >
            Agents
          </p>
          <h2
            style={{
              fontSize: mobile ? 32 : 52,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.92)',
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
              marginBottom: mobile ? 20 : 32,
            }}
          >
            An agent of our own.
            <br />
            <span style={{ color: `${active.accent}cc`, transition: 'color 0.4s' }}>And every CLI you use.</span>
          </h2>

          {/* Adapter tabs - horizontal scroll on mobile */}
          <div
            style={{
              display: 'flex',
              flexDirection: mobile ? 'row' : 'column',
              gap: mobile ? 8 : 3,
              ...(mobile ? { overflowX: 'auto', paddingBottom: 8 } : {}),
            }}
          >
            {adapters.map((adapter, i) => {
              const isActive = i === activeIndex
              return (
                <div
                  key={adapter.id}
                  onClick={() => setActiveIndex(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: mobile ? 10 : 16,
                    padding: mobile ? '10px 14px' : '9px 16px',
                    borderRadius: mobile ? 12 : 14,
                    background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                    cursor: 'pointer',
                    transition: 'background 0.4s',
                    flexShrink: 0,
                    ...(mobile ? { minWidth: 'fit-content' } : {}),
                  }}
                >
                  <div
                    style={{
                      width: mobile ? 32 : 38,
                      height: mobile ? 32 : 38,
                      borderRadius: mobile ? 8 : 10,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: isActive ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)',
                      flexShrink: 0,
                      transition: 'background 0.4s',
                    }}
                  >
                    <img
                      src={adapter.icon}
                      alt=""
                      style={{
                        width: mobile ? 16 : 19,
                        height: mobile ? 16 : 19,
                        filter: iconFilter(adapter.id),
                        opacity: isActive ? 0.9 : 0.25,
                        transition: 'opacity 0.4s',
                      }}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontSize: mobile ? 13 : 16,
                        fontWeight: 500,
                        color: isActive ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.25)',
                        transition: 'color 0.4s',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {adapter.name}
                    </div>
                    {!mobile && (
                      <div
                        style={{
                          fontSize: 13,
                          color: isActive ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)',
                          transition: 'color 0.4s',
                          marginTop: 2,
                        }}
                      >
                        {adapter.label}
                      </div>
                    )}
                  </div>
                  {isActive && !mobile && (
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        backgroundColor: active.accent,
                        opacity: 0.7,
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Divider */}
        {!mobile && (
          <div style={{ width: 1, alignSelf: 'stretch', minHeight: 480, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />
        )}

        {/* Right: active adapter detail — stretched to the row height and vertically centered so it stays visually balanced with the taller left column instead of leaving the bottom empty */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            alignSelf: mobile ? 'auto' : 'stretch',
            ...(mobile
              ? {}
              : { display: 'flex', flexDirection: 'column', justifyContent: 'center' }),
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: mobile ? 14 : 20, marginBottom: mobile ? 16 : 32 }}>
            <div
              style={{
                width: mobile ? 44 : 64,
                height: mobile ? 44 : 64,
                borderRadius: mobile ? 12 : 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: `${active.accent}18`,
                border: `1px solid ${active.accent}30`,
                transition: 'all 0.4s',
                flexShrink: 0,
              }}
            >
              <img
                src={active.icon}
                alt=""
                style={{
                  width: mobile ? 22 : 32,
                  height: mobile ? 22 : 32,
                  filter: iconFilter(active.id),
                  opacity: 0.85,
                }}
              />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h3
                  style={{
                    fontSize: mobile ? 24 : 44,
                    fontWeight: 600,
                    color: 'rgba(255,255,255,0.92)',
                    letterSpacing: '-0.025em',
                    lineHeight: 1.1,
                  }}
                >
                  {active.name}
                </h3>
                {active.native && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 10px',
                      borderRadius: 999,
                      background: `${active.accent}18`,
                      border: `1px solid ${active.accent}40`,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        backgroundColor: active.accent,
                        opacity: 0.9,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        color: 'rgba(255,255,255,0.7)',
                        fontWeight: 600,
                      }}
                    >
                      Native
                    </span>
                  </span>
                )}
              </div>
              <p style={{ fontSize: mobile ? 12 : 15, color: 'rgba(255,255,255,0.3)', marginTop: mobile ? 2 : 6 }}>
                {active.label}
              </p>
            </div>
          </div>

          <p
            style={{
              fontSize: mobile ? 14 : 20,
              lineHeight: 1.7,
              color: 'rgba(255,255,255,0.4)',
              fontWeight: 300,
              marginBottom: mobile ? 20 : 40,
            }}
          >
            {active.description}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 1fr', gap: mobile ? 8 : 14 }}>
            {active.features.map((feature, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: mobile ? 10 : 14,
                  padding: mobile ? '12px 14px' : '18px 22px',
                  borderRadius: mobile ? 10 : 16,
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.04)',
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: active.accent,
                    opacity: 0.5,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: mobile ? 13 : 15, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
                  {feature}
                </span>
              </div>
            ))}
          </div>

        </div>
      </div>
    </div>
  )
}
