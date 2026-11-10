import { describe, expect, it } from 'vitest'
import { validateUi, type UiElement } from './catalog'
import { layoutFlow } from './flow-layout'
import { UI_MAX_NODES, parseUi } from './parse'

const validated = (source: string) => validateUi(parseUi(source).nodes)

describe('parseUi', () => {
  it('keeps complete tags and waits on an unfinished one', () => {
    const result = parseUi('<metric label="A" value="1"/>\n<metric label="B" val')
    expect(result.pending).toBe(true)
    expect(result.nodes.map((node) => node.props.label)).toEqual(['A'])
  })

  it('never throws and never reorders on any prefix', () => {
    const source = '<stack><bar-chart title="a>b" max={10}>\n<bar label=\'x\' value="1"/>\n</bar-chart>\n<metric label="&lt;y" value="2"/></stack>'
    let previous = 0
    for (let end = 0; end <= source.length; end++) {
      const { nodes } = parseUi(source.slice(0, end))
      const count = JSON.stringify(nodes).match(/"key"/g)?.length ?? 0
      expect(count).toBeGreaterThanOrEqual(previous)
      previous = count
    }
    expect(parseUi(source).nodes[0].children[1].props.label).toBe('<y')
  })

  it('shows the children of an element that is still open', () => {
    const { nodes } = parseUi('<bar-chart max="9">\n<bar label="a" value="1"/>\n')
    expect(nodes[0].children).toHaveLength(1)
  })

  it('reads a > inside a quoted value and skips stray < in text', () => {
    const { nodes } = parseUi('1 < 2 <metric label="a > b" value="1"/>')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].props.label).toBe('a > b')
  })

  it('stops at the node limit', () => {
    const { nodes } = parseUi('<metric/>'.repeat(UI_MAX_NODES + 50))
    expect(nodes).toHaveLength(UI_MAX_NODES)
  })
})

describe('validateUi', () => {
  it('drops unknown tags and props but keeps the rest', () => {
    const { elements, diagnostics } = validated('<script src="x"/><metric label="A" value="1" style="position:fixed" onclick="x"/>')
    expect(elements).toHaveLength(1)
    expect(elements[0].props).toEqual({ label: 'A', value: '1' })
    expect(diagnostics.map((item) => item.code)).toEqual(['unknown_component', 'unknown_prop', 'unknown_prop'])
  })

  it('does not resolve object builtins as components or props', () => {
    const { elements, diagnostics } = validated('<constructor/><metric label="A" value="1" toString="x"/>')
    expect(elements).toHaveLength(1)
    expect(diagnostics.map((item) => item.code)).toEqual(['unknown_component', 'unknown_prop'])
  })

  it('enforces where a component may sit', () => {
    const { elements, diagnostics } = validated('<bar label="a" value="1"/><row><flow/></row>')
    expect(elements).toHaveLength(1)
    expect(elements[0].children).toHaveLength(0)
    expect(diagnostics.map((item) => item.code)).toEqual(['wrong_parent', 'wrong_parent'])
  })

  it('drops an invalid optional value and a node missing a required one', () => {
    const { elements, diagnostics } = validated('<bar-chart max="tall"><bar label="a" value="-1"/><bar label="b" value="2"/></bar-chart>')
    expect(elements[0].props).toEqual({})
    expect(elements[0].children).toHaveLength(1)
    expect(diagnostics.map((item) => item.code)).toEqual(['invalid_value', 'invalid_value', 'missing_prop'])
  })
})

describe('catalog', () => {
  it('nests stages in a group and nowhere else', () => {
    const { elements, diagnostics } = validated(
      '<stages><group columns="2"><stage title="A" tags="x, y，z"/><group/></group></stages><stage title="B"/>',
    )
    const group = elements[0].children[0]
    expect(group.children).toHaveLength(1)
    expect(group.children[0].props).toMatchObject({ tags: ['x', 'y', 'z'] })
    expect(diagnostics.map((item) => item.code)).toEqual(['wrong_parent', 'wrong_parent'])
  })

  it('drops an icon outside the list and an out-of-range count, keeping the block', () => {
    const { elements, diagnostics } = validated('<stages><stage title="A" icon="skull"/></stages><line-chart points="500" columns="2"/>')
    expect(elements[0].children[0].props).toEqual({ title: 'A' })
    expect(elements[1].props).toEqual({})
    expect(diagnostics.map((item) => [item.code, item.name])).toEqual([
      ['invalid_value', 'icon'],
      ['invalid_value', 'points'],
      ['unknown_prop', 'columns'],
    ])
  })

  it('allows a negative point but only known step statuses', () => {
    const { elements, diagnostics } = validated('<line-chart><point label="a" value="-3"/></line-chart><timeline><step title="b" status="stuck"/></timeline>')
    expect(elements[0].children[0].props).toEqual({ label: 'a', value: -3 })
    expect(elements[1].children[0].props).toEqual({ title: 'b' })
    expect(diagnostics.map((item) => item.name)).toEqual(['status'])
  })
})

describe('layoutFlow', () => {
  const source = [
    '<flow>',
    '<node id="a" label="A"/>',
    '<node id="b" label="B" after="a"/>',
    '<node id="c" label="C" after="a"/>',
    '<edge from="c" to="b"/>',
    '<node id="d" label="D" after="b,c"/>',
    '<node id="e" label="E" after="missing"/>',
  ].join('\n')

  const layoutOf = (text: string) => {
    const flow = validateUi(parseUi(text).nodes).elements[0] as UiElement | undefined
    return layoutFlow(flow?.children ?? [])
  }

  it('places a node one layer past its deepest parent', () => {
    const { nodes, edges, layers, rows } = layoutOf(source)
    expect(nodes.map(({ id, layer, row }) => [id, layer, row])).toEqual([
      ['a', 0, 0],
      ['b', 1, 0],
      ['c', 1, 1],
      ['d', 2, 0],
      ['e', 0, 1],
    ])
    expect(edges).toHaveLength(5)
    expect([layers, rows]).toEqual([3, 2])
  })

  it('never moves a node that is already placed', () => {
    const placed = new Map<string, string>()
    for (let end = 0; end <= source.length; end++) {
      for (const { id, layer, row } of layoutOf(source.slice(0, end)).nodes) {
        const position = `${layer}:${row}`
        expect(placed.get(id) ?? position).toBe(position)
        placed.set(id, position)
      }
    }
    expect(placed.size).toBe(5)
  })
})
