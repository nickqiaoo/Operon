import { test, expect, fakeOnly, setFakeScript, resetServerState } from '../ci-fixtures'
import { chat } from '../helpers'

test.beforeEach(async () => {
  await resetServerState()
})

test('thinking-effort slider moves to the next level', async ({ page }) => {
  await setFakeScript('verbatim-echo')
  await chat.openNewChat(page)

  const btn = page.getByTestId('chat-thinking-toggle').first()
  await expect(btn).toBeVisible({ timeout: 5_000 })

  const initial = ((await btn.textContent()) ?? '').trim()
  await btn.click()
  // The popover holds a stepped slider; arrow keys move one level and commit it.
  const thumb = page.getByRole('slider', { name: 'Thinking level' })
  await expect(thumb).toBeVisible()
  await thumb.focus()
  const atMax = (await thumb.getAttribute('aria-valuenow')) === (await thumb.getAttribute('aria-valuemax'))
  await thumb.press(atMax ? 'ArrowLeft' : 'ArrowRight')
  await expect(btn).not.toHaveText(initial)
})

test('the narrow desktop composer keeps its controls in a row below the input', async ({ page }) => {
  fakeOnly()
  await chat.openNewChat(page)
  await page.setViewportSize({ width: 480, height: 820 })

  const composer = page.locator('[data-slot="chat-composer"]')
  const input = composer.getByTestId('chat-input')
  const attach = composer.getByRole('button', { name: 'Attach files' })
  const model = composer.getByTestId('chat-model-selector')
  const thinking = composer.getByTestId('chat-thinking-toggle')
  const mode = composer.getByTestId('chat-mode-toggle')
  const submit = composer.getByTestId('chat-submit')

  await expect.poll(async () => {
    const [card, field, ...controls] = await Promise.all(
      [composer, input, attach, model, thinking, mode, submit].map((element) => element.boundingBox()),
    )
    return !!card && !!field && controls.every((button) =>
      button != null && button.y >= field.y + field.height &&
      button.y === controls[0]?.y && button.y + button.height <= card.y + card.height &&
      button.x >= card.x && button.x + button.width <= card.x + card.width,
    )
  }).toBe(true)

  await expect(model.locator('span.truncate')).toBeVisible()
  await model.click()
  const models = page.getByTestId('model-selector-list')
  await expect(models).toBeVisible()
  await models.getByRole('option').first().click()
  await expect(models).toBeHidden()
  await thinking.click()
  await expect(page.getByRole('slider', { name: 'Thinking level' })).toBeVisible()
  await page.keyboard.press('Escape')
  await mode.click()
  await expect(page.getByRole('menuitemradio').first()).toBeVisible()
  await page.keyboard.press('Escape')

  await input.fill('Keep this draft')
  await expect(submit).toBeEnabled()
  await page.setViewportSize({ width: 1280, height: 820 })
  await expect(input).toHaveValue('Keep this draft')
})
