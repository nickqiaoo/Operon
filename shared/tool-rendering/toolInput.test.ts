import { describe, expect, it } from 'vitest'
import { classifyToolInput, inferFieldLanguage } from './toolInput'
import { formatToolDisplayName, getToolDescription, unwrapToolEnvelope } from './toolName'
import { countAxNodes, parseAccessibilitySnapshot } from './accessibilityTree'

describe('classifyToolInput', () => {
  it('renders a lone multiline string as text, so newlines survive', () => {
    const view = classifyToolInput({ command: 'ls -la\ncd /tmp' })
    expect(view).toEqual({
      kind: 'text',
      field: 'command',
      value: 'ls -la\ncd /tmp',
      language: 'bash',
    })
  })

  it('renders a lone long string as text even without newlines', () => {
    const view = classifyToolInput({ prompt: 'x'.repeat(200) })
    expect(view.kind).toBe('text')
    if (view.kind === 'text') expect(view.language).toBe('markdown')
  })

  it('keeps a lone short string as a key/value row', () => {
    const view = classifyToolInput({ path: '/a/b.ts' })
    expect(view.kind).toBe('fields')
  })

  it('renders flat scalars as fields, covering the common MCP shape', () => {
    const view = classifyToolInput({ owner: 'anthropics', repo: 'claude-code', issue_number: 12 })
    expect(view.kind).toBe('fields')
    if (view.kind !== 'fields') return
    expect(view.fields.map((f) => f.key)).toEqual(['owner', 'repo', 'issue_number'])
    expect(view.fields.every((f) => !f.multiline)).toBe(true)
  })

  it('flags a multiline value inside an otherwise flat object', () => {
    const view = classifyToolInput({ cmd: 'a\nb', description: 'run it' })
    expect(view.kind).toBe('fields')
    if (view.kind !== 'fields') return
    expect(view.fields.find((f) => f.key === 'cmd')?.multiline).toBe(true)
    expect(view.fields.find((f) => f.key === 'description')?.multiline).toBe(false)
  })

  it('preserves non-string scalars', () => {
    const view = classifyToolInput({ dryRun: true, limit: 50, cursor: null })
    expect(view.kind).toBe('fields')
    if (view.kind !== 'fields') return
    expect(view.fields.map((f) => f.value)).toEqual(['true', '50', 'null'])
  })

  it('falls back to JSON for genuinely nested structures', () => {
    expect(classifyToolInput({ filters: { state: 'open' }, ids: [1, 2] }).kind).toBe('json')
  })

  it('reports empty and non-object inputs', () => {
    expect(classifyToolInput({}).kind).toBe('empty')
    expect(classifyToolInput([1, 2]).kind).toBe('json')
    expect(classifyToolInput('raw').kind).toBe('json')
  })
})

describe('getToolDescription', () => {
  it('prefers a well-known field', () => {
    expect(getToolDescription('bash', { command: 'ls -la' })).toBe('ls -la')
  })

  it('summarizes scalar args when no well-known field matches', () => {
    expect(
      getToolDescription('mcp__github__create_issue', { owner: 'a', repo: 'b', issue_number: 12 }),
    ).toBe('owner=a · repo=b')
  })

  it('summarizes non-string scalars, which readString skips', () => {
    expect(getToolDescription('unknown_tool', { issue_number: 12 })).toBe('issue_number=12')
  })

  it('clips long values', () => {
    const summary = getToolDescription('unknown_tool', { note: 'y'.repeat(60) })
    expect(summary?.endsWith('…')).toBe(true)
    expect(summary!.length).toBeLessThan(45)
  })

  it('returns undefined when nothing scalar is available', () => {
    expect(getToolDescription('unknown_tool', { nested: { a: 1 } })).toBeUndefined()
  })
})

describe('inferFieldLanguage', () => {
  it('maps the node_repl `source` argument to javascript', () => {
    expect(inferFieldLanguage('source')).toBe('javascript')
    expect(inferFieldLanguage('code')).toBe('javascript')
  })

  it('maps shell arguments to bash and everything else to markdown', () => {
    expect(inferFieldLanguage('command')).toBe('bash')
    expect(inferFieldLanguage('description')).toBe('markdown')
  })

  it('tags a multiline field with its language', () => {
    const view = classifyToolInput({ source: 'await computer.click()\n', description: 'click' })
    expect(view.kind).toBe('fields')
    if (view.kind !== 'fields') return
    expect(view.fields.find((f) => f.key === 'source')?.language).toBe('javascript')
    // Inline fields carry no language — nothing to highlight on one line.
    expect(view.fields.find((f) => f.key === 'description')?.language).toBeUndefined()
  })
})

describe('parseAccessibilitySnapshot', () => {
  const snapshot = [
    'App=com.tencent.qq (pid 9797)',
    'Window: "QQ", App: QQ.',
    '0 标准窗口 QQ, Secondary Actions: Raise',
    '\t1 HTML 内容, URL: app://./renderer/index.html',
    '\t\t2 container',
    '\t\t\t3 按钮 切换为经典模式',
    '\t82 关闭按钮',
    '85 菜单栏',
  ].join('\n')

  it('splits the header from the tree', () => {
    const parsed = parseAccessibilitySnapshot(snapshot)
    expect(parsed?.header).toEqual(['App=com.tencent.qq (pid 9797)', 'Window: "QQ", App: QQ.'])
    expect(parsed?.nodeCount).toBe(6)
  })

  it('rebuilds nesting from indentation', () => {
    const parsed = parseAccessibilitySnapshot(snapshot)
    expect(parsed?.roots.map((r) => r.index)).toEqual([0, 85])
    const root = parsed!.roots[0]!
    expect(root.children.map((c) => c.index)).toEqual([1, 82])
    expect(root.children[0]!.children[0]!.children[0]!.index).toBe(3)
    expect(countAxNodes(root)).toBe(5)
  })

  it('separates role from label', () => {
    const parsed = parseAccessibilitySnapshot(snapshot)
    const button = parsed!.roots[0]!.children[0]!.children[0]!.children[0]!
    expect(button.role).toBe('按钮')
    expect(button.label).toBe('切换为经典模式')
    // A node with no label leaves it undefined rather than empty-string.
    expect(parsed!.roots[0]!.children[0]!.children[0]!.label).toBeUndefined()
  })

  it('handles space indentation as well as tabs', () => {
    const parsed = parseAccessibilitySnapshot('0 window\n  1 button\n  2 button\n    3 image')
    expect(parsed?.roots[0]?.children.map((c) => c.index)).toEqual([1, 2])
    expect(parsed?.roots[0]?.children[1]?.children[0]?.index).toBe(3)
  })

  it('returns undefined for output that is not a snapshot', () => {
    expect(parseAccessibilitySnapshot('hello\nworld\nfoo')).toBeUndefined()
    expect(parseAccessibilitySnapshot('just one line')).toBeUndefined()
    expect(parseAccessibilitySnapshot('0 win\n\t1 btn\n\t2 btn\ntrailing prose')).toBeUndefined()
    expect(parseAccessibilitySnapshot('0 win\n\t1 btn')).toBeUndefined()
  })
})

describe('formatToolDisplayName', () => {
  it('splits MCP names into server and tool', () => {
    expect(formatToolDisplayName('mcp__github__create_issue')).toBe('github · create_issue')
    expect(formatToolDisplayName('mcp__claude-in-chrome__navigate')).toBe('claude-in-chrome · navigate')
  })

  it('leaves ordinary names alone', () => {
    expect(formatToolDisplayName('tool-Bash')).toBe('Bash')
    expect(formatToolDisplayName('Bash')).toBe('Bash')
  })
})

// Regression: grok (over ACP) routes every call through a generic `use_tool`
// envelope and relays MCP results as `{ output, raw }`. Both shapes previously
// rendered as raw JSON — the exact payloads below are from a real session.
describe('grok use_tool envelope', () => {
  it('unwraps the envelope to the real tool and its arguments', () => {
    const { toolName, input } = unwrapToolEnvelope('use_tool', {
      tool_name: 'node_repl__js',
      tool_input: { source: 'await computer.click({ element_index: 45 })', description: 'Open chat' },
    })
    expect(toolName).toBe('node_repl__js')
    expect(input).toEqual({
      source: 'await computer.click({ element_index: 45 })',
      description: 'Open chat',
    })
  })

  it('classifies the unwrapped arguments instead of a nested blob', () => {
    const envelope = { tool_name: 'node_repl__js', tool_input: { source: 'a\nb', description: 'x' } }
    // Before unwrapping, tool_input is a nested object -> the JSON tier.
    expect(classifyToolInput(envelope).kind).toBe('json')
    const { input } = unwrapToolEnvelope('use_tool', envelope)
    const view = classifyToolInput(input)
    expect(view.kind).toBe('fields')
    if (view.kind !== 'fields') return
    expect(view.fields.find((f) => f.key === 'source')?.language).toBe('javascript')
  })

  it('leaves ordinary tool calls untouched', () => {
    const input = { command: 'ls -la' }
    expect(unwrapToolEnvelope('Bash', input)).toEqual({ toolName: 'Bash', input })
    // A partial envelope is not an envelope.
    expect(unwrapToolEnvelope('use_tool', { tool_name: 'x' }).toolName).toBe('use_tool')
  })
})
