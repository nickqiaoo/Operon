import type { UiElement } from './catalog'

export interface FlowLayoutNode {
  key: string
  id: string
  label: string
  layer: number
  row: number
}

export interface FlowLayoutEdge {
  from: FlowLayoutNode
  to: FlowLayoutNode
}

export interface FlowLayout {
  nodes: FlowLayoutNode[]
  edges: FlowLayoutEdge[]
  layers: number
  rows: number
  /** How many nodes each layer holds so far. */
  layerSizes: number[]
}

/**
 * Places each node from what is known when it arrives: one layer past its
 * deepest parent, below whatever that layer already holds. A later node can
 * therefore never move an earlier one, which is what lets a flow grow while
 * the text streams. `after` naming a node not seen yet is ignored.
 */
export function layoutFlow(children: UiElement[]): FlowLayout {
  const byId = new Map<string, FlowLayoutNode>()
  const heights: number[] = []
  const edges: FlowLayoutEdge[] = []
  const edgeKeys = new Set<string>()

  const connect = (from: FlowLayoutNode | undefined, to: FlowLayoutNode | undefined) => {
    if (!from || !to || from === to) return
    const key = JSON.stringify([from.id, to.id])
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ from, to })
  }

  for (const child of children) {
    if (child.type === 'node') {
      const { id, label, after = [] } = child.props
      if (byId.has(id)) continue
      const parents = after.flatMap((parent) => byId.get(parent) ?? [])
      const layer = parents.length > 0 ? Math.max(...parents.map((parent) => parent.layer)) + 1 : 0
      const row = heights[layer] ?? 0
      heights[layer] = row + 1
      const node = { key: child.key, id, label, layer, row }
      byId.set(id, node)
      for (const parent of parents) connect(parent, node)
    } else if (child.type === 'edge') {
      connect(byId.get(child.props.from), byId.get(child.props.to))
    }
  }

  return { nodes: [...byId.values()], edges, layers: heights.length, rows: Math.max(0, ...heights), layerSizes: heights }
}
