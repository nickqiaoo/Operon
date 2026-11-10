import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageResponse } from '@/components/ai-elements/message'

const reply = [
  'Before the chart.',
  '',
  '```ui',
  '<bar-chart title="Latency" max="100" unit="ms">',
  '<bar label="US" value="42"/>',
  '<bar label="EU" value="58"/>',
  '</bar-chart>',
  '<flow>',
  '<node id="a" label="Client"/>',
  '<node id="b" label="Gateway" after="a"/>',
  '</flow>',
  '```',
  '',
  'After the chart.',
].join('\n')

// Through the real Streamdown: this is the path a streaming reply takes.
const render = (text: string) => renderToStaticMarkup(<MessageResponse>{text}</MessageResponse>)

describe('ui block in a reply', () => {
  it('draws the components, not the source', () => {
    const html = render(reply)
    expect(html).toContain('data-ui-block')
    expect(html).toContain('Gateway')
    expect(html).not.toContain('bar-chart')
    expect(html).toContain('After the chart.')
  })

  it('shows pieces only as their tags complete', () => {
    const upTo = (marker: string) => reply.slice(0, reply.indexOf(marker) + marker.length)
    const halfway = render(upTo('<bar label="EU" val'))
    expect(halfway).toContain('data-ui-block')
    expect(halfway).toContain('>US<')
    expect(halfway).not.toContain('>EU<')
    expect(render(upTo('<bar label="EU" value="58"/>'))).toContain('>EU<')
  })

  it('renders every prefix without throwing or leaking tag source', () => {
    for (let end = 0; end <= reply.length; end += 3) {
      expect(render(reply.slice(0, end))).not.toContain('&lt;bar label')
    }
  })

  it('gives a row its declared columns before the cards arrive', () => {
    const html = render('```ui\n<row columns="3">\n<metric label="A" value="1"/>\n')
    expect(html).toContain('--ui-cols:3')
  })

  const allBlocks = [
    '```ui',
    '<stages title="Arch">',
    '<stage icon="user" title="Browser" desc="Sends it" tags="HTTP/2,TLS"/>',
    '<group title="Backend" columns="2" note="Shared">',
    '<stage icon="server" title="API"/>',
    '<stage icon="database" title="Store"/>',
    '</group>',
    '</stages>',
    '<compare columns="2">',
    '<option title="REST" badge="Recommended">',
    '<pro text="Cacheable"/>',
    '<con text="Over-fetches"/>',
    '</option>',
    '</compare>',
    '<timeline>',
    '<step title="Migrate" time="Mon" status="done"/>',
    '<step title="Release"/>',
    '</timeline>',
    '<line-chart title="Traffic" max="100" points="3" unit="%">',
    '<point label="Mon" value="50"/>',
    '<point label="Tue" value="80"/>',
    '</line-chart>',
    '```',
  ].join('\n')

  it('draws every block type', () => {
    const html = render(allBlocks)
    expect(html).toContain('data-ui-dropped="0"')
    for (const text of ['Browser', 'HTTP/2', 'Backend', 'Shared', 'Store', 'Recommended', 'Cacheable', 'Over-fetches', 'Migrate', 'Release', 'Traffic', '>Tue<', '80%']) {
      expect(html).toContain(text)
    }
  })

  it('fixes each point at its declared slot before later points arrive', () => {
    const upTo = allBlocks.slice(0, allBlocks.indexOf('<point label="Tue"'))
    const html = render(upTo)
    expect(html).toContain('left:0%')
    expect(html).not.toContain('>Tue<')
    expect(render(allBlocks)).toContain('left:50%')
  })

  it('renders every prefix of every block without leaking tag source', () => {
    for (let end = 0; end <= allBlocks.length; end += 2) {
      expect(render(allBlocks.slice(0, end))).not.toMatch(/&lt;(stage|option|step|point)\b/)
    }
  })

  it('does not run or echo what the catalog refuses', () => {
    const html = render('```ui\n<metric label="A" value="1"/>\n<script>alert(1)</script>\n<img src="https://x.test/a.png"/>\n```')
    expect(html).toContain('>A<')
    expect(html).toContain('data-ui-dropped="2"')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('x.test')
  })
})
