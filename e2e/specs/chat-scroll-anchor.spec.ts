import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

declare global {
  interface Window {
    __conversationScrollTest: {
      prepend: () => void
      grow: (height?: number) => void
      append: () => void
      reply: () => void
      anchor: () => void
      cleanup: () => void
    }
    __vite_plugin_react_preamble_installed__: boolean
  }
}

const harness = readFileSync('e2e/scroll/main-harness.js', 'utf8')
const fixedHeightHarness = readFileSync('e2e/scroll/harness.js', 'utf8')

for (const width of [390, 1280]) {
  test.describe(`conversation scroll at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: width === 390 })

    test.beforeEach(async ({ page }) => {
      // Mount the real transcript without the rest of the app or live sessions.
      await page.route('**/.__scroll_review.html', route => route.fulfill({
        contentType: 'text/html',
        body: `<html><head><script type="module">
          import RefreshRuntime from '/@react-refresh';
          RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$ = () => {};
          window.$RefreshSig$ = () => type => type;
          window.__vite_plugin_react_preamble_installed__ = true;
          import '/src/styles/globals.css';
        </script></head><body></body></html>`,
      }))
      await page.goto('/.__scroll_review.html')
      await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__)
      await page.evaluate(harness)
      await expect(page.locator('[data-conversation-scroller]')).toBeVisible()
      await expect(page.locator('[data-message-id="main-row-49"]')).toHaveCount(1)
      await page.locator('#conversation-scroll-test').evaluate((host, viewportWidth) => {
        Object.assign(host.style, { left: '0px', top: '0px', width: `${viewportWidth}px`, height: '800px' })
      }, width)
      await expect.poll(() => page.locator('[data-conversation-scroller]').evaluate(viewport =>
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      )).toBeLessThanOrEqual(2)
      await page.evaluate(() => document.fonts.ready)
      await expect(page.locator('[data-conversation-scroller]')).not.toHaveAttribute('data-autoscrolling', '')
    })

    test('keeps continuous upward scrolling smooth while older rows mount and resize', async ({ page }) => {
      const deltas = await page.locator('[data-conversation-scroller]').evaluate(async viewport => {
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
        viewport.scrollTop = 1100
        viewport.dispatchEvent(new Event('scroll'))
        await new Promise(resolve => setTimeout(resolve, 200))
        const anchor = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].find(element => {
          const top = element.getBoundingClientRect().top
          return top >= 0 && top < viewport.clientHeight
        })
        if (!anchor) throw new Error('No visible message to track')
        const positions: number[] = []
        for (let frame = 0; frame < 55; frame++) {
          viewport.scrollTop -= 8
          if (frame === 12) window.__conversationScrollTest.prepend()
          await new Promise(requestAnimationFrame)
          positions.push(anchor.getBoundingClientRect().top)
        }
        return positions.slice(1).map((position, index) => position - positions[index])
      })
      // Every finger step moves content down; neither a reverse jump nor a
      // swallowed step is allowed when the 240px history placeholders expand.
      expect(Math.min(...deltas)).toBeGreaterThan(6)
      expect(Math.max(...deltas)).toBeLessThan(10)
    })

    test('preserves reading position through streamed growth and new prompts', async ({ page }) => {
      const viewport = page.locator('[data-conversation-scroller]')
      await viewport.evaluate(element => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
        element.scrollTop = 1100
      })
      await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toHaveAttribute('data-active', 'true')
      const before = await viewport.evaluate(element => element.scrollTop)
      await page.evaluate(() => {
        window.__conversationScrollTest.grow()
        window.__conversationScrollTest.append()
      })
      await expect(page.locator('[data-message-id="main-row-50"]')).toHaveCount(1)
      await page.waitForTimeout(300)
      expect(await viewport.evaluate(element => element.scrollTop)).toBeCloseTo(before, 0)

    })

    test('still anchors new turns and follows replies and viewport resizing at the end', async ({ page }) => {
      await page.evaluate(() => window.__conversationScrollTest.cleanup())
      await page.evaluate(fixedHeightHarness)
      await page.locator('#conversation-scroll-test').evaluate((host, viewportWidth) => {
        Object.assign(host.style, { left: '0px', top: '0px', width: `${viewportWidth}px`, height: '800px' })
      }, width)
      const viewport = page.locator('[data-conversation-scroller]')
      await expect.poll(() => viewport.evaluate(element =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
      )).toBeLessThanOrEqual(2)
      await page.evaluate(() => window.__conversationScrollTest.anchor())
      const prompt = page.locator('[data-message-id="anchored"]')
      await expect(prompt).toBeVisible()
      await expect.poll(() => prompt.evaluate(element => Math.abs(element.getBoundingClientRect().top - 80))).toBeLessThan(2)
      await page.evaluate(() => window.__conversationScrollTest.grow(1000))
      await expect.poll(() => viewport.evaluate(element =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
      )).toBeLessThanOrEqual(2)
      await viewport.evaluate(element => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
        element.scrollTop -= 300
      })
      await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toHaveAttribute('data-active', 'true')
      await page.getByRole('button', { name: 'Scroll to bottom' }).click()
      await expect.poll(() => viewport.evaluate(element =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
      )).toBeLessThanOrEqual(2)
      await page.locator('#conversation-scroll-test').evaluate(host => { host.style.height = '500px' })
      await expect.poll(() => viewport.evaluate(element =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
      )).toBeLessThanOrEqual(2)
    })
  })
}
