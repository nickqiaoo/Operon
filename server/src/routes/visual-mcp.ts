/** Lets any agent show a visual reply (chart, diagram, mockup) inline in its conversation. */
import { Hono, type Context } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_PREVIEW_MAX_WIDTH,
  HTML_RENDER_PREVIEW_MIN_WIDTH,
  HTML_RENDER_PREVIEW_TOOL_NAME,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
} from '@shared/html-render'
import { HtmlRenderError, previewHtmlRender, publishHtmlRender } from '../services/visual/html-render.js'
import { getHtmlSnapshotter } from '../services/visual/html-snapshot.js'
import { serveMcpOverHono, withCodexElicitationFallback } from './mcp-http.js'

const PAGE_RULES = 'Inline <style> and <script>; scripts from CDNs load as-is. Local images referenced by absolute path are embedded.'

const htmlParam = { type: 'string', description: 'A complete, self-contained HTML document.' }

const renderTool = (canPreview: boolean): Tool => ({
  name: HTML_RENDER_TOOL_NAME,
  description: [
    'Show an HTML page inline in this conversation, where this call appears, for what is clearer seen than read:',
    'how parts connect or a process flows, a step-by-step or interactive walkthrough, side-by-side comparisons, data with a trend, UI mockups, live examples of a visual effect.',
    'Explanations that read well as text, code, lists or simple tables stay in markdown.',
    'Not for an image the user wants as a file to post or send: write a .png and give its path instead. Never start a server for it.',
    canPreview ? `Check the page with ${HTML_RENDER_PREVIEW_TOOL_NAME} first, fix what it shows, and pass its contentHeight as height.` : '',
    PAGE_RULES,
    'Do not announce or restate the page in your reply.',
    HTML_RENDER_LAYOUT_GUIDE,
    HTML_RENDER_THEME_GUIDE,
  ].filter(Boolean).join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      html: htmlParam,
      title: { type: 'string', maxLength: HTML_RENDER_MAX_TITLE_LENGTH, description: 'Short name for the page, used for its file name and screen readers.' },
      height: {
        type: 'integer',
        minimum: HTML_RENDER_MIN_HEIGHT,
        maximum: HTML_RENDER_MAX_HEIGHT,
        description: `Height in CSS pixels at ${HTML_RENDER_COLUMN_WIDTH}px wide${canPreview ? `: the contentHeight from ${HTML_RENDER_PREVIEW_TOOL_NAME}` : ''}. The frame reserves it until the page reports its real height.`,
      },
    },
    required: ['html', 'title', 'height'],
  },
  annotations: { title: 'Render HTML', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
})

const previewTool: Tool = {
  name: HTML_RENDER_PREVIEW_TOOL_NAME,
  description: [
    `Check an HTML page before ${HTML_RENDER_TOOL_NAME}, without showing it to the user.`,
    'Renders it the way the conversation will and returns a screenshot, the page\'s contentHeight, console output, and local image paths that are not readable images.',
    'Look for empty or misplaced boxes, overlapping or clipped text, and console errors, fix them, and preview again if you changed much.',
    PAGE_RULES,
    `Layout and theme rules are in ${HTML_RENDER_TOOL_NAME}.`,
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      html: htmlParam,
      width: {
        type: 'integer',
        minimum: HTML_RENDER_PREVIEW_MIN_WIDTH,
        maximum: HTML_RENDER_PREVIEW_MAX_WIDTH,
        description: `CSS pixels. Default ${HTML_RENDER_COLUMN_WIDTH}, the reply width on desktop. Use about 390 to check phones.`,
      },
      appearance: { type: 'string', enum: ['dark', 'light'], description: 'Default dark.' },
      screenshot: { type: 'boolean', description: 'Default true. Pass false if you cannot view images; the rest of the result still comes back.' },
    },
    required: ['html'],
  },
  annotations: { title: 'Preview HTML', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}

export function buildVisualMcpServer(): Server {
  const server = new Server({ name: 'visual', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Headless nodes have nothing to render with: the tool is not offered at all
    // rather than offered and always failing.
    const canPreview = getHtmlSnapshotter() !== null
    return { tools: canPreview ? [previewTool, renderTool(true)] : [renderTool(false)] }
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    try {
      if (req.params.name === HTML_RENDER_PREVIEW_TOOL_NAME) {
        const preview = await previewHtmlRender({ html: args.html, width: args.width, appearance: args.appearance })
        if (!preview) throw new HtmlRenderError(`Preview is not available here. Call ${HTML_RENDER_TOOL_NAME} directly.`)
        const { jpeg, ...report } = preview
        const text = { type: 'text' as const, text: JSON.stringify(report) }
        return args.screenshot === false
          ? { content: [text] }
          : { content: [{ type: 'image' as const, data: jpeg.toString('base64'), mimeType: 'image/jpeg' }, text] }
      }
      if (req.params.name !== HTML_RENDER_TOOL_NAME) throw new Error(`Unknown tool: ${req.params.name}`)
      const visual = await publishHtmlRender({ html: args.html, title: args.title, height: args.height })
      const result = {
        visual,
        message: "Shown to the user where this call appears. Don't mention or describe the page; reply with only what it doesn't already say.",
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    } catch (error) {
      if (!(error instanceof HtmlRenderError)) console.error(`[visual-mcp] ${req.params.name} failed:`, error)
      return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  })
  return withCodexElicitationFallback(server)
}

export function visualMcpRoutes() {
  const router = new Hono()
  const handle = (c: Context) => serveMcpOverHono(c, buildVisualMcpServer())
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)
  return router
}
