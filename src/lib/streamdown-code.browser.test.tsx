import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { Streamdown } from 'streamdown'
import { safeCode } from './streamdown-code'

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
})

test('updates fenced code when the content changes without moving its boundaries', async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const render = async (code: string, isAnimating = true) => {
    await act(async () => {
      root?.render(
        <Streamdown mode="streaming" isAnimating={isAnimating} plugins={{ code: safeCode }}>
          {'```ts\n' + code + '\n```'}
        </Streamdown>,
      )
    })
  }
  const visibleCode = () => container?.querySelector('pre')?.textContent
  await render('{ chatId: 123')
  await expect.poll(visibleCode).toContain('{ chatId: 123')
  // The closing fence remains on line 3, column 1 in all three renders.
  const full = '{ chatId: 123, active: true, turnId: "abc" }'
  await render(full)
  await expect.poll(visibleCode).toContain(full)
  // Equal-length replacement must also update, including when the turn ends.
  const final = '{ chatId: 456, active: true, turnId: "xyz" }'
  await render(final, false)
  await expect.poll(visibleCode).toContain(final)
})
