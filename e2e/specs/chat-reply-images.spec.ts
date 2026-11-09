import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Workspace } from '../../src/stores/project-store'
import { test, expect, fakeOnly, resetServerState, setFakeScript, waitForStreamIdle } from '../ci-fixtures'
import { chat } from '../helpers'

const apiUrl = `http://127.0.0.1:${process.env.PW_CI_SERVER_PORT ?? 4100}/api`
const CHAT_TITLE = 'Screenshots of the card'
const PROJECT_NAME = 'Image Repo'
/** A real 1x1 png, so the test proves the bytes load and not only that an <img> exists. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

test('a finished reply shows the local images it mentions under its text', async ({ page }, testInfo) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'operon-reply-images-'))
  const listed = join(root, '1-card.png')
  const inSentence = join(root, '2-menu.png')
  const markdownImage = join(root, '3-dispatched.png')
  for (const file of [listed, inSentence, markdownImage]) writeFileSync(file, PNG)
  const missing = join(root, 'gone.png')

  const { project } = await (await page.request.post(`${apiUrl}/projects`, { data: { name: PROJECT_NAME, rootPath: root } })).json() as { project: Project }
  const { workspace } = await (await page.request.post(`${apiUrl}/projects/${project.id}/workspaces`, { data: { name: 'repo-main', branchName: 'main', worktreePath: root } })).json() as { workspace: Workspace }
  await page.request.post(`${apiUrl}/chat-history`, { data: {
    providerId: 'fake', model: 'fake-1', workspaceId: workspace.id, tp: 'chat', title: CHAT_TITLE,
    messages: [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Show me the card' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: [
        'The menu is at ' + inSentence + ', and the result is here ![](' + markdownImage + ').',
        '',
        'Screenshots:',
        '',
        '- ' + listed,
        '- ' + missing,
      ].join('\n') }] },
    ],
  } })
  await page.reload()

  const workspaceRow = page.getByText('repo-main').first()
  if (!(await workspaceRow.isVisible())) await page.getByText(PROJECT_NAME).first().click()
  await workspaceRow.click()
  await page.getByRole('button', { name: 'Chat history' }).click()
  await page.getByText(CHAT_TITLE).first().click()

  const gallery = page.getByTestId('reply-image-gallery')
  // Reading order, and the missing file drops out of the gallery.
  await expect(gallery.locator('figcaption')).toHaveText(['2-menu.png', '3-dispatched.png', '1-card.png'])
  await expect.poll(() => gallery.locator('img').evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).naturalWidth))).toEqual([1, 1, 1])

  // The prose keeps the paths, and a local image no longer renders as a broken one.
  const reply = page.getByTestId('message-assistant')
  await expect(reply.getByText(missing)).toBeVisible()
  await expect(reply.getByRole('link', { name: '3-dispatched.png' })).toBeVisible()
  await expect(page.getByText('Image not available')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('reply-images.png') })

  await gallery.getByRole('button', { name: 'Preview 1-card.png' }).click()
  await expect(page.getByRole('dialog').locator('img')).toBeVisible()
})

test('a reply ending with images settles at the bottom without opening and closing gaps', async ({ page }) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'operon-reply-images-'))
  const shot = join(root, '1-card.png')
  writeFileSync(shot, PNG)
  const missing = join(root, 'gone.png')

  // A slow stat is the window a placeholder for the missing file would show in.
  await page.route('**/api/fs/stat', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.fallback()
  })
  await chat.openNewChat(page, 'echo')
  await chat.sendMessage(page, 'Long enough to scroll.\n\n' + Array.from({ length: 60 }, (_, i) => `Line ${i}`).join('\n\n'))
  await waitForStreamIdle(page)

  const scroller = page.locator('[data-conversation-scroller]')
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight * 1.5)).toBe(true)
  await page.evaluate(() => {
    const samples: { height: number; captions: string[]; gap: number }[] = []
    Object.assign(window, { __replySamples: samples })
    const tick = () => {
      const viewport = document.querySelector('[data-conversation-scroller]')
      const galleries = document.querySelectorAll('[data-testid="reply-image-gallery"]')
      const gallery = galleries[galleries.length - 1]
      if (viewport && gallery) {
        samples.push({
          height: gallery.getBoundingClientRect().height,
          captions: [...gallery.querySelectorAll('figcaption')].map((caption) => caption.textContent ?? ''),
          gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await chat.sendMessage(page, `Screenshots: ${shot} and ${missing}`)
  await waitForStreamIdle(page)
  const gallery = page.getByTestId('reply-image-gallery').last()
  await expect(gallery.locator('figcaption')).toHaveText(['1-card.png'])
  await expect.poll(() => gallery.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1)
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2)

  const samples = await page.evaluate(() => (window as unknown as { __replySamples: { height: number; captions: string[]; gap: number }[] }).__replySamples)
  expect(samples.flatMap((sample) => sample.captions)).not.toContain('gone.png')
  const heights = samples.map((sample) => sample.height)
  expect(heights.every((height, index) => index === 0 || height >= heights[index - 1])).toBe(true)
})
