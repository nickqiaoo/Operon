import { z } from 'zod'
import type { UiSourceNode } from './parse'

/**
 * What a ```ui block may contain. Anything else is dropped and the rest still
 * renders: the model's output is data, and these rules are all that stands
 * between it and the page, so a prop here must never carry raw CSS or a URL.
 */

const text = z.string().trim().min(1).max(200)
const nonNegative = z.string().trim().min(1).transform(Number).pipe(z.number().finite().nonnegative())
const positive = z.string().trim().min(1).transform(Number).pipe(z.number().finite().positive())
const idList = z
  .string()
  .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))

const longText = z.string().trim().min(1).max(400)
const finite = z.string().trim().min(1).transform(Number).pipe(z.number().finite())
const columns = z.enum(['1', '2', '3', '4']).transform(Number).optional()
const listOf = (limit: number) =>
  z.string().transform((value) => value.split(/[,，]/).map((item) => item.trim()).filter(Boolean).slice(0, limit))
const tags = listOf(6)
const items = listOf(8)

/**
 * Named colors a part may take. ui-block.tsx maps each to theme tokens (chart-*,
 * brand, muted), so a block follows light/dark and the ported themes, and the
 * model still cannot write a color of its own.
 */
export const UI_TONES = ['blue', 'green', 'amber', 'orange', 'pink', 'purple', 'gray'] as const
export type UiTone = (typeof UI_TONES)[number]
const tone = z.enum(UI_TONES).optional()

/** The icons a block may name. ui-block.tsx maps each to its glyph. */
export const UI_ICONS = [
  'cloud', 'code', 'cpu', 'database', 'file', 'git', 'globe', 'layout',
  'lock', 'message', 'package', 'search', 'server', 'shield', 'terminal', 'user', 'workflow', 'zap',
] as const
export type UiIconName = (typeof UI_ICONS)[number]

const BLOCKS = ['stack', 'row', 'metric', 'bar-chart', 'flow', 'stages', 'compare', 'timeline', 'line-chart'] as const

const CATALOG = {
  stack: { props: {}, children: BLOCKS },
  row: { props: { columns }, children: ['metric'] },
  stages: { props: { title: text.optional(), note: longText.optional() }, children: ['stage', 'group', 'arrow'] },
  group: { props: { title: text.optional(), columns, note: text.optional(), tone }, children: ['stage'] },
  stage: {
    props: {
      title: text,
      desc: longText.optional(),
      items: items.optional(),
      tags: tags.optional(),
      icon: z.enum(UI_ICONS).optional(),
      tone,
    },
    children: [],
  },
  arrow: { props: { label: text.optional(), dir: z.enum(['down', 'up', 'both']).optional() }, children: [] },
  compare: { props: { title: text.optional(), columns }, children: ['option'] },
  option: {
    props: { title: text, summary: longText.optional(), badge: z.string().trim().min(1).max(24).optional() },
    children: ['pro', 'con'],
  },
  pro: { props: { text: longText }, children: [] },
  con: { props: { text: longText }, children: [] },
  timeline: { props: { title: text.optional() }, children: ['step'] },
  step: {
    props: {
      title: text,
      desc: longText.optional(),
      time: z.string().trim().min(1).max(40).optional(),
      status: z.enum(['done', 'active', 'pending', 'failed']).optional(),
    },
    children: [],
  },
  'line-chart': {
    props: {
      title: text.optional(),
      min: finite.optional(),
      max: finite.optional(),
      points: z.string().trim().min(1).transform(Number).pipe(z.number().int().min(2).max(60)).optional(),
      unit: z.string().trim().max(12).optional(),
      tone,
    },
    children: ['point'],
  },
  point: { props: { label: text, value: finite }, children: [] },
  metric: { props: { label: text, value: text, hint: text.optional(), tone }, children: [] },
  'bar-chart': {
    props: { title: text.optional(), max: positive.optional(), unit: z.string().trim().max(12).optional(), tone },
    children: ['bar'],
  },
  bar: { props: { label: text, value: nonNegative, tone }, children: [] },
  flow: { props: { title: text.optional() }, children: ['node', 'edge'] },
  node: {
    props: { id: text, label: text, after: idList.optional(), icon: z.enum(UI_ICONS).optional(), tone },
    children: [],
  },
  edge: { props: { from: text, to: text }, children: [] },
} satisfies Record<string, { props: z.ZodRawShape; children: readonly string[] }>

type Catalog = typeof CATALOG
export type UiElementType = keyof Catalog

export type UiElement = {
  [K in UiElementType]: {
    key: string
    type: K
    props: z.output<z.ZodObject<Catalog[K]['props']>>
    children: UiElement[]
  }
}[UiElementType]

export type UiDiagnosticCode = 'unknown_component' | 'wrong_parent' | 'unknown_prop' | 'invalid_value' | 'missing_prop'

export interface UiDiagnostic {
  code: UiDiagnosticCode
  key: string
  name: string
}

export interface UiValidation {
  elements: UiElement[]
  diagnostics: UiDiagnostic[]
}

function validateChildren(nodes: UiSourceNode[], allowed: readonly string[], diagnostics: UiDiagnostic[]): UiElement[] {
  const elements: UiElement[] = []
  for (const node of nodes) {
    // hasOwn: a tag named `constructor` must not resolve to Object.prototype's.
    if (!Object.hasOwn(CATALOG, node.type)) {
      diagnostics.push({ code: 'unknown_component', key: node.key, name: node.type })
      continue
    }
    if (!allowed.includes(node.type)) {
      diagnostics.push({ code: 'wrong_parent', key: node.key, name: node.type })
      continue
    }

    const definition = CATALOG[node.type as UiElementType]
    const shape: Record<string, z.ZodType> = definition.props
    const props: Record<string, unknown> = {}
    for (const [name, raw] of Object.entries(node.props)) {
      if (!Object.hasOwn(shape, name)) {
        diagnostics.push({ code: 'unknown_prop', key: node.key, name })
        continue
      }
      const parsed = shape[name].safeParse(raw)
      if (parsed.success) props[name] = parsed.data
      else diagnostics.push({ code: 'invalid_value', key: node.key, name })
    }

    const missing = Object.keys(shape).filter((name) => !(name in props) && !shape[name].safeParse(undefined).success)
    if (missing.length > 0) {
      for (const name of missing) diagnostics.push({ code: 'missing_prop', key: node.key, name })
      continue
    }

    elements.push({
      key: node.key,
      type: node.type,
      props,
      children: validateChildren(node.children, definition.children, diagnostics),
    } as UiElement)
  }
  return elements
}

export function validateUi(nodes: UiSourceNode[]): UiValidation {
  const diagnostics: UiDiagnostic[] = []
  return { elements: validateChildren(nodes, BLOCKS, diagnostics), diagnostics }
}

/** Reader-facing numbers: a chart's value labels. */
export const formatUiNumber = (value: number) => String(Number(value.toFixed(2)))
