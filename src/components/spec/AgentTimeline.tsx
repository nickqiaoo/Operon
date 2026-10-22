import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, CircleAlert, CirclePause, CornerDownRight, LoaderCircle } from 'lucide-react'
import { ProviderLabel } from '@/components/icons/ProviderLabel'
import './agent-timeline.css'

export interface TimelineAgent {
  id: string
  role: string
  model: string
  provider: string
  color: string
  start: number
  end?: number
  status: 'running' | 'done' | 'failed' | 'stopped'
}

export interface OrchestratorSegment {
  start: number
  end: number
  state: 'working' | 'delegating'
}

export interface AgentTimelineProps {
  orchestrator: OrchestratorSegment[]
  statusLabel?: string
  agents: TimelineAgent[]
  elapsed: number
  running: boolean
  onSelectAgent?: (agent: TimelineAgent) => void
}

const ROW = 44
const TOP = 22
const X = 14

function time(seconds: number) {
  return seconds < 60 ? `${Number(seconds.toFixed(1))}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

/** Times are elapsed seconds. The top rail represents the workflow, not a fabricated agent. */
export function AgentTimeline({ statusLabel = 'Agent activity', agents, elapsed: elapsedSnapshot, running, orchestrator, onSelectAgent }: AgentTimelineProps) {
  // Advance locally between server snapshots; new snapshots re-anchor the clock.
  const [clock, setClock] = useState({ snapshot: elapsedSnapshot, delta: 0 })
  useEffect(() => {
    setClock({ snapshot: elapsedSnapshot, delta: 0 })
    if (!running) return
    const started = performance.now()
    const timer = window.setInterval(() => {
      setClock({ snapshot: elapsedSnapshot, delta: (performance.now() - started) / 1000 })
    }, 50)
    return () => window.clearInterval(timer)
  }, [elapsedSnapshot, running])
  const elapsed = elapsedSnapshot + (running && clock.snapshot === elapsedSnapshot ? clock.delta : 0)
  const hatchId = useId()
  const liveHatchId = `${hatchId}-live`
  const scrollRef = useRef<HTMLDivElement>(null)
  const [windowSeconds, setWindowSeconds] = useState(300)
  const [follow, setFollow] = useState(true)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(180, entry.contentRect.width - 210)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const maximum = Math.max(elapsed, ...agents.map(agent => agent.end ?? agent.start), 1)
  const domain = Math.max(30, maximum + Math.min(maximum * .08, windowSeconds === 0 ? Infinity : windowSeconds * .08))
  const visibleSeconds = windowSeconds === 0 ? domain : Math.min(domain, windowSeconds)
  // Bound SVG dimensions for multi-day runs; render only visible grid ticks.
  const plotWidth = Math.min(4000000, Math.max(width, width * domain / visibleSeconds))
  const right = plotWidth - 16
  const pixelsPerSecond = (right - X) / domain
  const roughStep = width / pixelsPerSecond / 6
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400].find(value => value >= roughStep) ?? Math.ceil(roughStep / 86400) * 86400
  const plotHeight = TOP + ROW * agents.length + 18
  const position = (seconds: number) => X + Math.max(0, Math.min(seconds / domain, 1)) * (right - X)
  const firstTick = Math.max(0, Math.floor(scrollLeft / pixelsPerSecond / step))
  const lastTick = Math.min(Math.floor(domain / step), Math.ceil((scrollLeft + width) / pixelsPerSecond / step))
  const ticks = Array.from({ length: Math.max(0, lastTick - firstTick + 1) }, (_, index) => (index + firstTick) * step)
  const maxScroll = Math.max(0, plotWidth - width)
  useLayoutEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollLeft = maxScroll
      setScrollLeft(maxScroll)
    }
  }, [follow, maxScroll])
  const active = agents.filter(agent => agent.status === 'running').length
  const failed = agents.some(agent => agent.status === 'failed')
  const complete = agents.every(agent => agent.status === 'done')

  return (
    <section className="spec-agent-timeline" aria-label="Agent activity timeline">
      <header className="timeline-header">
        <div>
          <div className="timeline-summary">
            {running ? <LoaderCircle className="summary-icon spinning" /> : failed ? <CircleAlert className="summary-icon failed" /> : complete ? <Check className="summary-icon complete" /> : <CirclePause className="summary-icon" />}
            <span>{agents.length} agents</span><span className="separator">·</span><span>{time(elapsed)}</span>
            <span className="separator">·</span><span>{running ? `${active} running` : failed ? 'Needs attention' : statusLabel}</span>
          </div>
        </div>
        <span className={`run-badge ${running ? 'is-live' : failed ? 'is-failed' : ''}`}><i />{running ? 'Live' : failed ? 'Failed' : 'Recorded'}</span>
      </header>

      <div className="timeline-controls">
        <label>Time scale <select aria-label="Time scale" value={windowSeconds} onChange={(event) => setWindowSeconds(Number(event.target.value))}>
          <option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={3600}>1 hour</option><option value={0}>Fit all</option>
        </select></label>
        <button type="button" aria-pressed={follow} onClick={() => setFollow(!follow)}>Follow latest</button>
      </div>
      <div ref={scrollRef} className="timeline-scroll" tabIndex={0} aria-label="Scrollable agent timeline" onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)} onWheel={(event) => { if (event.deltaX !== 0 || event.shiftKey) setFollow(false) }} onPointerDown={() => setFollow(false)} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) setFollow(false) }}>
        <div className="timeline-layout" style={{ width: plotWidth + 210 }}>
          <div className="agent-labels">
            <div className="agent-label workflow-label" style={{ height: ROW }}>
              <span className="agent-dot workflow-dot" /><div><h3>Orchestrator</h3><p>Spec workflow</p></div>
            </div>
            {agents.map(agent => {
              return <button key={agent.id} className="agent-label" style={{ height: ROW }} disabled={!onSelectAgent} onClick={() => onSelectAgent?.(agent)}>
                <span className="agent-dot" style={{ background: agent.color }} />
                <div><h3 title={agent.role}>{agent.role}</h3><p><ProviderLabel id={agent.provider}>{agent.model}</ProviderLabel></p></div>
              </button>
            })}
          </div>

          <svg className="timeline-plot" style={{ width: plotWidth, height: plotHeight + 28 }} viewBox={`0 0 ${plotWidth} ${plotHeight + 28}`} role="img" aria-label={agents.map(agent => `${agent.role}: ${time(agent.start)} to ${agent.end === undefined ? 'now' : time(agent.end)}, ${agent.status}`).join('. ')}>
            <defs>
              <pattern id={hatchId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(42)">
                <line x1="0" y1="0" x2="0" y2="8" className="orchestrator-hatch" />
              </pattern>
              <pattern id={liveHatchId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(42)">
                <g className="flowing-hatch">
                  <line x1="-8" y1="-16" x2="-8" y2="24" className="orchestrator-hatch" />
                  <line x1="0" y1="-16" x2="0" y2="24" className="orchestrator-hatch" />
                  <line x1="8" y1="-16" x2="8" y2="24" className="orchestrator-hatch" />
                </g>
              </pattern>
            </defs>
            {ticks.map(tick => <g key={tick}>
              <line x1={position(tick)} x2={position(tick)} y1="0" y2={plotHeight} className="grid-line" />
              <text x={position(tick)} y={plotHeight + 22} textAnchor={tick === domain ? 'end' : 'middle'} className="tick-label">{time(tick)}</text>
            </g>)}
            {orchestrator.filter(segment => segment.start < elapsed).map((segment, index) => {
              const current = running && segment.start < elapsed && segment.end >= elapsed
              const x = position(segment.start) + (index === 0 ? 0 : 2)
              const segmentWidth = Math.max(position(Math.min(segment.end, elapsed)) - x - 2, 1)
              return <g key={segment.start} className={current ? 'orchestrator-current' : undefined}>
                <rect x={x} y={TOP - 11} width={segmentWidth} height="22" rx="6" className={`orchestrator-segment ${segment.state}`} />
                {segment.state === 'delegating' && <rect x={x} y={TOP - 11} width={segmentWidth} height="22" rx="6" fill={`url(#${current ? liveHatchId : hatchId})`} />}
                <title>{segment.state === 'working' ? 'Workflow interval' : 'Agents running'}{current ? ' · Active now' : ''}</title>
              </g>
            })}
            {agents.map((agent, index) => {
              const y = TOP + (index + 1) * ROW
              const start = position(agent.start)
              const end = position(agent.end ?? elapsed)
              const inset = Math.min(12, Math.max(0, (end - start) / 4))
              const barWidth = Math.max(end - start - inset * 2, 10)
              const barX = Math.min(start + inset, right - barWidth)
              return <g key={agent.id}>
                <path d={`M ${start} ${TOP + 12} V ${y - 12} Q ${start} ${y} ${start + inset} ${y}`} fill="none" stroke={agent.color} strokeWidth="2" opacity=".85" />
                <circle cx={start} cy={TOP + 12} r="5.5" fill={agent.color} className="handoff-dot" />
                {agent.end !== undefined && <>
                  <path d={`M ${end - inset} ${y} Q ${end} ${y} ${end} ${y - 12} V ${TOP + 12}`} fill="none" stroke={agent.color} strokeWidth="2" opacity=".85" />
                  <circle cx={end} cy={TOP + 12} r="5.5" fill={agent.color} className="handoff-dot" />
                </>}
                <rect x={barX} y={y - 11} width={barWidth} height="22" rx="6" fill={agent.color} className={agent.status === 'running' ? 'agent-bar-live' : undefined} style={{ color: agent.color }} />
                {agent.status === 'running' && <circle cx={barX + barWidth - Math.min(9, barWidth / 2)} cy={y} r="3" fill="white" className="activity-dot" />}
                {agent.status === 'failed' && <text x={barX + barWidth / 2} y={y + 5} textAnchor="middle" fill="white" fontSize="17">×</text>}
                <title>{agent.role} · {agent.model} · {agent.status} · {time((agent.end ?? elapsed) - agent.start)}</title>
              </g>
            })}
            {running && <line x1={position(elapsed)} x2={position(elapsed)} y1={TOP + 22} y2={plotHeight} className="live-time-guide" />}
            <line x1={X} x2={right} y1={plotHeight} y2={plotHeight} className="axis-line" />
            <circle cx={position(elapsed)} cy={plotHeight} r="5" className="time-marker" />
          </svg>
        </div>
      </div>
      {maxScroll > 0 && <input className="timeline-pan" type="range" aria-label="Pan timeline" min={0} max={maxScroll} step="any" value={Math.min(scrollLeft, maxScroll)} onChange={(event) => {
        setFollow(false)
        if (scrollRef.current) scrollRef.current.scrollLeft = Number(event.target.value)
        setScrollLeft(Number(event.target.value))
      }} />}
      <footer className="timeline-footer">
        <span title="Very short calls use a minimum visible width. Hover a bar for its actual duration.">{statusLabel} · Hover for duration</span>
        <span className="legend"><i />Agent run <CornerDownRight size={14} />Start & finish</span>
      </footer>
    </section>
  )
}
