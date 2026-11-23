import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { FileOpenProvider } from '@/lib/file-open-context'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { MessageResponse } from './message'
import { Reasoning, ReasoningContent } from './reasoning'

let root: Root
let container: HTMLDivElement
const openFile = vi.fn()
const fence = '\x60'.repeat(3)

beforeAll(async () => {
  await Promise.all([
    import('./words-message-markdown'),
    import('./markdown-html-block'),
    import('./mermaid-block'),
    import('mermaid'),
  ])
})

beforeEach(() => {
  openFile.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

test('keeps streamed code current when the source boundaries stay the same', async () => {
  const render = (code: string, isAnimating = true) => act(async () => {
    root.render(
      <MessageResponse mode="streaming" isAnimating={isAnimating}>
        {fence + 'ts\n' + code + '\n' + fence}
      </MessageResponse>,
    )
  })
  const visibleCode = () => container.querySelector('pre')?.textContent
  await render('{ chatId: 123')
  await expect.poll(visibleCode).toContain('{ chatId: 123')
  await render('{ chatId: 123, active: true, turnId: "abc" }')
  await expect.poll(visibleCode).toContain('{ chatId: 123, active: true, turnId: "abc" }')
  await render('{ chatId: 456, active: true, turnId: "xyz" }', false)
  await expect.poll(visibleCode).toContain('{ chatId: 456, active: true, turnId: "xyz" }')
  expect(container.querySelector('pre code span[style*="--operon-code-"]')).not.toBeNull()
})

test('adds clickable citations and incremental charts without replacing the Words root or prose', async () => {
  const queryClient = new QueryClient()
  const render = (source: string, isAnimating = true) => act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <FileOpenProvider value={openFile}>
          <MessageResponse isAnimating={isAnimating}>{source}</MessageResponse>
        </FileOpenProvider>
      </QueryClientProvider>,
    )
  })
  const prefix = 'Prose stays here.\n\n'
  await render(prefix)
  await expect.poll(() => container.querySelector('[data-markdown="root"] p')?.textContent).toBe('Prose stays here.')
  const markdownRoot = container.querySelector('[data-markdown="root"]')
  const paragraph = markdownRoot?.querySelector('p')
  const citation = 'See 【F:/tmp/a.ts†L42-L43】.\n\n'
  const chart = fence + 'ui\n<row columns="2">\n<metric label="CPU" value="42"/>\n'
  await render(prefix + citation + chart)
  await expect.poll(() => container.querySelector('[data-ui-block]')?.textContent).toContain('CPU')
  const chartNode = container.querySelector('[data-ui-block]')
  const chip = container.querySelector<HTMLButtonElement>('button[title="/tmp/a.ts"]')
  expect(chip?.textContent).toContain('lines 42-43')
  chip?.click()
  expect(openFile).toHaveBeenCalledWith('/tmp/a.ts', { line: 42 })

  await render(prefix + citation + chart + '<metric label="RAM" value="25"/>\n</row>\n' + fence + '\n\nAfter it.', false)
  expect(container.querySelector('[data-markdown="root"]')).toBe(markdownRoot)
  expect(markdownRoot?.querySelector('p')).toBe(paragraph)
  expect(container.querySelector('[data-ui-block]')).toBe(chartNode)
  expect(chartNode?.textContent).toContain('RAM')
  expect(markdownRoot?.textContent).toContain('After it.')
  expect(markdownRoot?.textContent).not.toContain('<metric')
})

test('renders duplicate heading anchors, single line breaks and sanitized HTML in previews', async () => {
  const content = [
    '## Read me', '', 'First line', 'Second line', '', '## Read me', '',
    'Press <kbd>Enter</kbd><br>Now.', '',
    '<details><summary>More</summary><p>Details</p></details>', '',
    '<script>throw new Error("forbidden")</script>',
  ].join('\n')
  await act(async () => root.render(<MarkdownRenderer content={content} breaks />))
  await expect.poll(() => container.querySelector('details summary')?.textContent).toBe('More')
  expect(Array.from(container.querySelectorAll('h2'), (heading) => heading.id)).toEqual(['read-me', 'read-me-1'])
  expect(container.querySelector('p br')).not.toBeNull()
  expect(container.querySelector('kbd')?.textContent).toBe('Enter')
  expect(container.querySelectorAll('script')).toHaveLength(0)
  expect(container.textContent).not.toContain('forbidden')
  expect(container.querySelectorAll('[data-markdown="root"]')).toHaveLength(1)
})

test('shows HTML that would render to nothing as its text', async () => {
  await act(async () => root.render(<MarkdownRenderer content={'<p align="center">'} />))
  await expect.poll(() => container.textContent?.trim()).toBe('<p align="center">')

  await act(async () => root.render(<MarkdownRenderer content={'<p align="center"><img src="https://example.com/logo.png"></p>'} />))
  await expect.poll(() => container.querySelector('img')).not.toBeNull()
  expect(container.textContent).not.toContain('<p')
})

test('offers Mermaid download, zoom and expanded view within the Words reply', async () => {
  const source = fence + 'mermaid\nflowchart LR\n A[Start] --> B[End]\n' + fence
  await act(async () => root.render(<MessageResponse>{source}</MessageResponse>))
  await expect.poll(() => container.querySelector('[data-mermaid-block] svg[id^="operon-mermaid-"]'), { timeout: 12000 }).not.toBeNull()
  const downloaded: string[] = []
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloaded.push(this.download)
  })
  try {
    for (const format of ['SVG', 'PNG']) {
      await act(async () => {
        container.querySelector('[aria-label="Download diagram"]')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        )
      })
      await expect.poll(() => document.querySelector('[role="menu"]')).not.toBeNull()
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((entry) => entry.textContent === format)
      await act(async () => item?.click())
      await expect.poll(() => downloaded).toContain('diagram.' + format.toLowerCase())
    }
  } finally {
    anchorClick.mockRestore()
  }
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click())
  expect(container.querySelector('[data-mermaid-block] svg[id^="operon-mermaid-"]')?.parentElement?.style.width).toBe('125%')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand diagram"]')?.click())
  await expect.poll(() => document.querySelector('[role="dialog"] svg[id$="-expanded"]')).not.toBeNull()
})

test('uses Words for reasoning text', async () => {
  await act(async () => root.render(
    <Reasoning open isStreaming>
      <ReasoningContent>Thinking in **Markdown**</ReasoningContent>
    </Reasoning>,
  ))
  await expect.poll(() => container.querySelector('[data-markdown="root"] strong')?.textContent).toBe('Markdown')
})
