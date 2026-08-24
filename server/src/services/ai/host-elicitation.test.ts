import { describe, expect, it } from 'vitest'
import { shouldAutoReviewBrowserOrigin } from './host-elicitation.js'

const request = {
  message: 'Allow Browser Use to access https://www.bilibili.com?',
  meta: {
    tool_name: 'access_browser_origin',
    origin: 'https://www.bilibili.com',
  },
}

describe('Browser Use auto review', () => {
  it('accepts an explicitly named host or known site alias', () => {
    expect(shouldAutoReviewBrowserOrigin(request, 'Fetch Bilibili hot top 10')).toBe(true)
    expect(shouldAutoReviewBrowserOrigin(request, '帮我获取 B站 热门视频')).toBe(true)
    expect(shouldAutoReviewBrowserOrigin(request, '打开 https://www.bilibili.com 看一下')).toBe(true)
  })

  it('does not infer permission from a generic browsing request', () => {
    expect(shouldAutoReviewBrowserOrigin(request, '帮我找十个热门视频')).toBe(false)
  })

  it('fails closed when the user names the site only to reject access', () => {
    expect(shouldAutoReviewBrowserOrigin(request, '不要访问 B站，直接解释这个错误')).toBe(false)
    expect(shouldAutoReviewBrowserOrigin(request, 'Bilibili should not be used')).toBe(false)
    expect(shouldAutoReviewBrowserOrigin(request, "Don't use bilibili.com")).toBe(false)
  })

  it('never auto-reviews sensitive Browser Use capabilities', () => {
    expect(shouldAutoReviewBrowserOrigin({
      ...request,
      meta: { ...request.meta, full_cdp_access: true },
    }, 'Fetch Bilibili hot top 10')).toBe(false)
    expect(shouldAutoReviewBrowserOrigin({
      ...request,
      meta: { ...request.meta, file_transfer: 'upload' },
    }, 'Upload this file to Bilibili')).toBe(false)
  })
})
