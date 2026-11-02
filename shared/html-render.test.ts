import { describe, expect, it } from 'vitest'
import {
  buildHtmlRenderDocument,
  readHtmlRenderContentHeight,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
  readHtmlRenderRef,
} from './html-render'

const theme = { appearance: 'dark' as const, variables: { '--background': '#0b0b0d', '--bad;}': 'x', '--foreground': 'red;}</style>' } }
const url = `/api/attachments/${'a'.repeat(64)}`

describe('buildHtmlRenderDocument', () => {
  it('injects first inside <head>', () => {
    const doc = buildHtmlRenderDocument('<!doctype html><html><head><title>x</title></head><body>hi</body></html>', theme)
    expect(doc.indexOf('id="operon-theme"')).toBeGreaterThan(doc.indexOf('<head>'))
    expect(doc.indexOf('id="operon-theme"')).toBeLessThan(doc.indexOf('<title>'))
  })

  it('does not land inside a comment or script that mentions <head>', () => {
    const doc = buildHtmlRenderDocument('<!-- <head> --><script>"<head>"</script><html><head></head></html>', theme)
    expect(doc).toContain('<!-- <head> --><script>"<head>"</script><html><head><meta')
  })

  it('wraps a fragment', () => {
    expect(buildHtmlRenderDocument('<div>x</div>', theme)).toMatch(/^<!doctype html><meta [^>]*Content-Security-Policy.*<head>.*<\/head><div>x<\/div>$/s)
  })

  it('puts the network policy ahead of everything but the doctype', () => {
    const policy = '<meta http-equiv="Content-Security-Policy"'
    const early = buildHtmlRenderDocument('<script src="https://evil.example/x.js"></script><head></head>', theme)
    expect(early.startsWith(policy)).toBe(true)
    const doctype = buildHtmlRenderDocument('<!-- c -->\n<!DOCTYPE html><html><head></head></html>', theme)
    expect(doctype.startsWith(`<!-- c -->\n<!DOCTYPE html>${policy}`)).toBe(true)
    expect(buildHtmlRenderDocument('<p>', theme, { standalone: true }).startsWith(`<!doctype html>${policy}`)).toBe(true)
  })

  it('keeps the page charset and viewport', () => {
    const doc = buildHtmlRenderDocument('<head><meta charset="utf-8"><meta name="viewport" content="width=500"></head>', theme)
    expect(doc.match(/charset/g)).toHaveLength(1)
    expect(doc.match(/name="viewport"/g)).toHaveLength(1)
  })

  it('paints the theme background only for a standalone file', () => {
    expect(buildHtmlRenderDocument('<p>', theme)).not.toContain('html{background:var(--background)}')
    expect(buildHtmlRenderDocument('<p>', theme, { standalone: true })).toContain('html{background:var(--background)}')
  })

  it('drops bad names and cannot be broken out of by a value', () => {
    const style = /<style id="operon-theme">(.*?)<\/style>/s.exec(buildHtmlRenderDocument('<p>', theme))?.[1] ?? ''
    expect(style).toContain('color-scheme:dark;--background:#0b0b0d;--foreground:red/style;')
    expect(style).not.toContain('--bad')
  })
})

describe('bridge messages', () => {
  it('reads a published ref and rejects anything that is not an attachment', () => {
    expect(readHtmlRenderRef({ url, title: ' Sales ', height: 5000 })).toEqual({ url, title: 'Sales', height: 2000 })
    expect(readHtmlRenderRef({ url: 'https://evil.example/x', title: 't', height: 100 })).toBeNull()
    expect(readHtmlRenderRef({ url, title: 't' })).toBeNull()
  })

  it('reads height and only http(s) links', () => {
    expect(readHtmlRenderContentHeight({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 321 } })).toBe(321)
    expect(readHtmlRenderContentHeight({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: -1 } })).toBeUndefined()
    expect(readHtmlRenderLinkRequest({ jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'https://a.b/' } })).toBe('https://a.b/')
    expect(readHtmlRenderLinkRequest({ jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'file:///etc/passwd' } })).toBeUndefined()
  })

  it('opens only inlined images', () => {
    const image = (src: string) => readHtmlRenderImageRequest({ jsonrpc: '2.0', method: 'operon/open-image', params: { src, name: ' chart ' } })
    expect(image('data:image/png;base64,AAAA')).toEqual({ src: 'data:image/png;base64,AAAA', name: 'chart' })
    // The app would fetch it, outside the page's network policy.
    expect(image('https://a.b/c.png?secret=1')).toBeUndefined()
    expect(image('javascript:alert(1)')).toBeUndefined()
    expect(image('file:///etc/passwd')).toBeUndefined()
  })
})
