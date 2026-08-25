import { ZoomableImage } from './ImageZoom'
import { SectionShell } from './SectionShell'
import { Reveal } from './Reveal'
import { SectionTitle, Lead, FeatureList, SplitLayout } from './SectionType'
import { useIsMobile } from '../hooks/useIsMobile'
import external1 from '../assets/external1.png'
import external2 from '../assets/external2.png'

const ACCENT = '#6366f1'

const FEATURES = [
  {
    title: 'Async Execution',
    desc: 'Child agents run in background tabs without blocking the main conversation.',
  },
  {
    title: 'Natural Language Orchestration',
    desc: 'Describe your multi-agent pipeline in plain text, with no code or config required.',
  },
  {
    title: 'Cross-Agent Context',
    desc: 'Message-based notification mechanism for seamless inter-agent communication.',
  },
]

export function ExternalAgentSection() {
  const mobile = useIsMobile()

  return (
    <SectionShell id="orchestration" accent={ACCENT} glow="right">
      <SplitLayout
        copyWidth={430}
        copy={
          <Reveal>
            <SectionTitle>
              One plans. One builds.
              <br />
              <span style={{ color: 'rgba(99,102,241,0.8)' }}>One reviews.</span>
            </SectionTitle>
            <Lead>
              Orchestrate agents with natural language. Claude Code plans, Codex executes, Gemini
              reviews. Delegate tasks across agents in real time from a single conversation.
            </Lead>
            <FeatureList items={FEATURES} accent={ACCENT} />
          </Reveal>
        }
        visual={
          <Reveal delay={45}>
            {/*
              Desktop overlaps the two shots — the review pass behind, the
              plan/execute handoff in front. A phone has no room for that: both
              would shrink past readable, so they stack full-width instead, in
              the order the work actually happens.
            */}
            {mobile ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {[
                  { src: external1, alt: 'Claude Code planning and Codex executing a feature' },
                  { src: external2, alt: 'Gemini reviewing the implementation and finding issues' },
                ].map((shot) => (
                  <div
                    key={shot.alt}
                    style={{
                      width: '100%',
                      borderRadius: 12,
                      overflow: 'hidden',
                      border: '1px solid rgba(255,255,255,0.08)',
                      boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
                    }}
                  >
                    <ZoomableImage src={shot.src} alt={shot.alt} style={{ width: '100%', display: 'block' }} />
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ position: 'relative', height: 500 }}>
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '84%',
                    borderRadius: 14,
                    overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.08)',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
                    zIndex: 1,
                  }}
                >
                  <ZoomableImage
                    src={external2}
                    alt="Gemini reviewing the implementation and finding issues"
                    style={{ width: '100%', display: 'block' }}
                  />
                </div>

                <div
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    right: 0,
                    width: '84%',
                    borderRadius: 14,
                    overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.08)',
                    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
                    zIndex: 2,
                  }}
                >
                  <ZoomableImage
                    src={external1}
                    alt="Claude Code planning and Codex executing a feature"
                    style={{ width: '100%', display: 'block' }}
                  />
                </div>
              </div>
            )}
          </Reveal>
        }
      />
    </SectionShell>
  )
}
