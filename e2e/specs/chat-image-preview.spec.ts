import { test, fakeOnly, expect, waitForStreamIdle, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  fakeOnly()
  await resetServerState()
})

test('image preview: zoom, pan, reset and reopen before and after sending', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'details.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#f1f5f9"/><text x="80" y="140" font-size="48">Preview details</text></svg>'),
  })

  const trigger = page.getByRole('button', { name: 'Preview details.svg' })
  await trigger.click()
  const dialog = page.getByRole('dialog')
  const canvas = dialog.getByLabel('Image canvas')
  const image = dialog.getByRole('img', { name: 'details.svg' })
  await expect(dialog.getByText('1,600 × 1,000 px')).toBeVisible()
  const fitted = await image.boundingBox()
  if (!fitted) throw new Error('Image is not visible')

  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(fitted.width)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await dialog.getByRole('button', { name: 'Copy image', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Image copied', exact: true })).toBeVisible()
  const copiedSize = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read()
    const bitmap = await createImageBitmap(await item.getType('image/png'))
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  })
  expect(copiedSize).toEqual({ width: 1600, height: 1000 })
  await dialog.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeCloseTo(fitted.width, 0)
  await dialog.getByRole('button', { name: '100%', exact: true }).click()
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBe(1600)

  const original = await image.boundingBox()
  const canvasBox = await canvas.boundingBox()
  if (!original || !canvasBox) throw new Error('Image canvas is not visible')
  const center = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 }
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 40, center.y + 30, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await image.boundingBox())?.x ?? 0).toBeGreaterThan(original.x)
  await page.mouse.wheel(0, -80)
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(1600)

  await dialog.getByRole('button', { name: 'Fit', exact: true }).click()
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeCloseTo(fitted.width, 0)
  await canvas.dblclick()
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(fitted.width)
  await page.keyboard.press('1')
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBe(1600)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeCloseTo(fitted.width, 0)
  await page.keyboard.press('Control+c')
  await expect(dialog.getByRole('button', { name: 'Image copied', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close image preview' }).click()

  await chat.sendMessage(page, 'See attached image')
  await waitForStreamIdle(page)
  await page.getByTestId('message-user').last().getByRole('button', { name: 'Preview details.svg' }).click()
  await expect(dialog.getByText('1,600 × 1,000 px')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 1000).toBeLessThan(390)
  const controls = await dialog.getByRole('group', { name: 'Image zoom controls' }).boundingBox()
  if (!controls) throw new Error('Zoom controls are not visible')
  expect(controls.x).toBeGreaterThanOrEqual(0)
  expect(controls.x + controls.width).toBeLessThanOrEqual(390)
  await expect(dialog.getByRole('button', { name: 'Close image preview' })).toBeVisible()
})
