import { readFileSync } from 'node:fs'
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

test.use({ screenshot: 'off' })

type ScrollHarness = {
  grow: (pixels: number) => void
  prepend: () => void
  trim: () => void
  append: () => void
  reply: () => void
  cleanup: () => void
}
declare global {
  interface Window { __conversationScrollTest?: ScrollHarness }
}
const harness = readFileSync(new URL('./scroll/harness.js', import.meta.url), 'utf8')
const viewport = (page: Page) => page.locator('#conversation-scroll-test [data-conversation-scroller]')
const gap = (page: Page) => viewport(page).evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
const top = (page: Page) => viewport(page).evaluate(el => el.scrollTop)
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
async function readEarlier(page: Page) {
  await viewport(page).hover()
  await page.mouse.wheel(0, -650)
  await expect.poll(() => gap(page)).toBeGreaterThan(300)
  await frames(page)
}

async function expectTurnNearTop(page: Page, id: string) {
  const row = page.locator(`#conversation-scroll-test [data-message-id="${id}"]`)
  await expect(row).toBeAttached()
  await expect.poll(async () => {
    const rowTop = await row.evaluate(el => el.getBoundingClientRect().top)
    const viewTop = await viewport(page).evaluate(el => el.getBoundingClientRect().top)
    return rowTop - viewTop
  }).toBeGreaterThanOrEqual(0)
  await expect.poll(async () => {
    const rowTop = await row.evaluate(el => el.getBoundingClientRect().top)
    const viewTop = await viewport(page).evaluate(el => el.getBoundingClientRect().top)
    return rowTop - viewTop
  }).toBeLessThanOrEqual(128)
}

test.describe('Conversation scroll regression', () => {
  test.beforeEach(async ({ appPage: page }) => {
    const result = await page.evaluate(harness)
    test.info().annotations.push({ type: 'engine', description: JSON.stringify(result) })
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  })
  test.afterEach(async ({ appPage: page }) => {
    await page.evaluate(() => window.__conversationScrollTest?.cleanup())
  })

  test('follows streamed content and sliding-window shrink at the bottom', async ({ appPage: page }) => {
    await page.evaluate(() => window.__conversationScrollTest!.grow(500))
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
    await page.evaluate(() => window.__conversationScrollTest!.trim())
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  })

  test('lets the first upward wheel escape and preserves reading position during streaming', async ({ appPage: page }) => {
    await readEarlier(page)
    const before = await top(page)
    await page.evaluate(() => window.__conversationScrollTest!.grow(500))
    await frames(page)
    expect(Math.abs(await top(page) - before)).toBeLessThanOrEqual(2)
  })

  test('jump to latest resumes following subsequent content', async ({ appPage: page }) => {
    await readEarlier(page)
    await page.locator('#conversation-scroll-test').getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
    await page.evaluate(() => window.__conversationScrollTest!.grow(250))
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  })

  test('keeps the visible message stable when older history is prepended', async ({ appPage: page }) => {
    await readEarlier(page)
    const before = await page.locator('#conversation-scroll-test [data-message-id="row-19"]').evaluate(el => el.getBoundingClientRect().top)
    await page.evaluate(() => window.__conversationScrollTest!.prepend())
    await frames(page)
    const after = await page.locator('#conversation-scroll-test [data-message-id="row-19"]').evaluate(el => el.getBoundingClientRect().top)
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2)
  })

  test('follows viewport resize at the bottom but leaves a reader in place', async ({ appPage: page }) => {
    await page.locator('#conversation-scroll-test').evaluate(el => { el.style.height = '300px' })
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
    await readEarlier(page)
    const before = await top(page)
    await page.locator('#conversation-scroll-test').evaluate(el => { el.style.height = '380px'; el.style.width = '420px' })
    await frames(page)
    expect(Math.abs(await top(page) - before)).toBeLessThanOrEqual(2)
  })

  test('expanding details does not pull the reader to the bottom', async ({ appPage: page }) => {
    const before = await top(page)
    await page.locator('#conversation-scroll-test').getByRole('button', { name: 'Expand details', exact: true }).click()
    await expect.poll(() => gap(page)).toBeGreaterThan(400)
    expect(Math.abs(await top(page) - before)).toBeLessThanOrEqual(2)
  })

  test('pins a following viewport before resize paint', async ({ appPage: page }) => {
    const gaps = await viewport(page).evaluate(async el => {
      const samples: number[] = []
      const observer = new ResizeObserver(() => samples.push(el.scrollHeight - el.clientHeight - el.scrollTop))
      observer.observe(el)
      const host = document.querySelector<HTMLElement>('#conversation-scroll-test')!
      for (const height of [300, 440, 280, 500]) {
        host.style.height = `${height}px`
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      }
      observer.disconnect()
      return samples
    })
    expect(gaps.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2)
  })

  test('preserves the first message when history arrives at scroll offset zero', async ({ appPage: page }) => {
    await readEarlier(page)
    await viewport(page).evaluate(el => { el.scrollTop = 0 })
    await frames(page)
    const row = page.locator('#conversation-scroll-test [data-message-id="row-0"]')
    const before = await row.evaluate(el => el.getBoundingClientRect().top)
    await page.evaluate(() => window.__conversationScrollTest!.prepend())
    await frames(page)
    expect(Math.abs(await row.evaluate(el => el.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(2)
  })

  test('touch scrolling releases following before the next streamed chunk', async ({ appPage: page }) => {
    await viewport(page).dispatchEvent('touchmove')
    await viewport(page).evaluate(el => { el.scrollTop -= 500 })
    await expect.poll(() => gap(page)).toBeGreaterThan(300)
    const before = await top(page)
    await page.evaluate(() => window.__conversationScrollTest!.grow(500))
    await frames(page)
    expect(Math.abs(await top(page) - before)).toBeLessThanOrEqual(2)
  })
})

test.describe('Assistant history integration', () => {
  test.beforeEach(async ({ appPage: page }) => {
    const source = readFileSync(new URL('./scroll/assistant-harness.js', import.meta.url), 'utf8')
    await page.evaluate(source)
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  })
  test.afterEach(async ({ appPage: page }) => {
    await page.evaluate(() => window.__conversationScrollTest?.cleanup())
  })

  test('reveals paged history and accepts incoming replies while reading older messages', async ({ appPage: page }) => {
    await expect(page.locator('#conversation-scroll-test [data-message-id]')).toHaveCount(40)
    await viewport(page).hover()
    await page.mouse.wheel(0, -1200)
    await expect.poll(() => gap(page)).toBeGreaterThan(400)
    const before = await top(page)
    await page.evaluate(() => window.__conversationScrollTest!.grow(500))
    await frames(page)
    expect(Math.abs(await top(page) - before)).toBeLessThanOrEqual(2)
    for (const id of ['assistant-row-40', 'assistant-row-0', 'assistant-row--20']) {
      await viewport(page).evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
      await expect(page.locator(`#conversation-scroll-test [data-message-id="${id}"]`)).toBeAttached()
      await frames(page)
    }
  })

  test('sending while reading history anchors the new turn near the top', async ({ appPage: page }) => {
    await viewport(page).hover()
    await page.mouse.wheel(0, -1200)
    await expect.poll(() => gap(page)).toBeGreaterThan(400)
    const input = page.locator('#conversation-scroll-test textarea')
    await input.fill('Return to latest')
    await page.locator('#conversation-scroll-test').getByRole('button', { name: 'Submit', exact: true }).click()
    await expectTurnNearTop(page, 'assistant-row-120')
  })
})

test.describe('Main transcript integration', () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.evaluate(readFileSync(new URL('./scroll/main-harness.js', import.meta.url), 'utf8'))
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(2)
  })
  test.afterEach(async ({ appPage: page }) => {
    await page.evaluate(() => window.__conversationScrollTest?.cleanup())
  })

  test('sending at the bottom anchors the new turn near the top', async ({ appPage: page }) => {
    await page.evaluate(() => window.__conversationScrollTest!.append())
    await expectTurnNearTop(page, 'main-row-50')
    await page.evaluate(() => window.__conversationScrollTest!.reply())
    await expectTurnNearTop(page, 'main-row-50')
  })

  test('turn navigator jumps to a registered row and releases streaming follow', async ({ appPage: page }) => {
    const rail = page.locator('#conversation-scroll-test [data-testid="chat-navigator"]')
    await rail.getByRole('button', { name: 'Question 10: verify navigation and history.', exact: true }).click()
    const row = page.locator('#conversation-scroll-test [data-message-id="main-row-10"]')
    const padding = await page.locator('#conversation-scroll-test [data-testid="message-list"]').evaluate(
      el => Number.parseFloat(getComputedStyle(el).paddingBlockStart),
    )
    await expect.poll(async () => {
      const rowTop = await row.evaluate(el => el.getBoundingClientRect().top)
      const viewTop = await viewport(page).evaluate(el => el.getBoundingClientRect().top)
      return Math.abs(rowTop - viewTop - padding - 12)
    }).toBeLessThanOrEqual(2)
    const before = await row.evaluate(el => el.getBoundingClientRect().top)
    await page.evaluate(() => window.__conversationScrollTest!.grow(500))
    await frames(page)
    expect(Math.abs(await row.evaluate(el => el.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(2)
    expect(await gap(page)).toBeGreaterThan(300)
  })

  test('deferred history rows keep the reading position while mounting', async ({ appPage: page }) => {
    await readEarlier(page)
    const row = page.locator('#conversation-scroll-test [data-message-id="main-row-46"]')
    const before = await row.evaluate(el => el.getBoundingClientRect().top)
    await page.evaluate(() => window.__conversationScrollTest!.prepend())
    await expect(page.locator('#conversation-scroll-test [data-message-id="main-row--8"]')).toBeAttached()
    await frames(page)
    expect(Math.abs(await row.evaluate(el => el.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(2)
  })
})
