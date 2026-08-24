/**
 * Parser for the indented accessibility snapshots that Computer Use tools print
 * (`computer.get_app_state`, surfaced through the `node_repl` MCP server):
 *
 *   App=com.tencent.qq (pid 9797)
 *   Window: "QQ", App: QQ.
 *   0 AXWindow Messages, Secondary Actions: Raise
 *   \t1 AXGroup content, URL: app://./renderer/index.html
 *   \t\t2 container
 *
 * Rendered as raw text these run to hundreds of lines and bury the one thing
 * the agent actually needs next: the element index. `js` can return anything,
 * so `parseAccessibilitySnapshot` returns undefined unless the text really
 * looks like a snapshot — callers fall back to plain text.
 */

export interface AxNode {
  index: number
  role: string
  /** Everything after the role: name, URL, value, secondary actions. */
  label?: string
  children: AxNode[]
}

export interface AxSnapshot {
  /** Lines before the tree starts (`App=…`, `Window: …`). */
  header: string[]
  roots: AxNode[]
  nodeCount: number
}

/** Below this many indexed lines the text is more likely prose than a snapshot. */
const MIN_TREE_LINES = 3

const TREE_LINE = /^([ \t]*)(\d+)(?:\s+(.*))?$/

export function parseAccessibilitySnapshot(text: string): AxSnapshot | undefined {
  if (typeof text !== 'string' || !text.includes('\n')) return undefined

  const lines = text.split('\n')
  const header: string[] = []
  const roots: AxNode[] = []
  // Each entry pairs a node with the indent width it was found at, so the tree
  // rebuilds correctly whether the source indents with tabs or spaces.
  const stack: Array<{ indent: number; node: AxNode }> = []
  let nodeCount = 0
  let seenTree = false

  for (const line of lines) {
    if (!line.trim()) continue

    const match = TREE_LINE.exec(line)
    if (!match) {
      // Leading prose is the snapshot header; prose *after* the tree started
      // means this isn't a clean snapshot, so bail out to plain text.
      if (seenTree) return undefined
      header.push(line.trim())
      continue
    }

    seenTree = true
    const indent = match[1]!.length
    const rest = (match[3] ?? '').trim()
    const spaceAt = rest.indexOf(' ')
    const node: AxNode = {
      index: Number(match[2]),
      role: spaceAt === -1 ? rest : rest.slice(0, spaceAt),
      label: spaceAt === -1 ? undefined : rest.slice(spaceAt + 1).trim() || undefined,
      children: [],
    }
    nodeCount += 1

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]?.node
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push({ indent, node })
  }

  if (nodeCount < MIN_TREE_LINES) return undefined
  return { header, roots, nodeCount }
}

/** Total nodes in a subtree, including the node itself. */
export function countAxNodes(node: AxNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countAxNodes(child), 0)
}
