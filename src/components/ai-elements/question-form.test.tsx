// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IntlProvider } from 'react-intl'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { QuestionForm, type Question } from './question-form'

const several: Question[] = [
  { title: 'Which agent?', options: ['Codex', 'Claude'] },
  { title: 'Which branch?', options: [] },
]

let root: Root | undefined
let host: HTMLDivElement

function setup(questions: readonly Question[], props: { body?: string; answer?: string; disabled?: boolean } = {}) {
  const onSubmit = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root?.render(
      <IntlProvider locale="en">
        <QuestionForm questions={questions} body={props.body ?? ''} answer={props.answer} disabled={props.disabled ?? false} onSubmit={onSubmit} />
      </IntlProvider>,
    )
  })
  return onSubmit
}

const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement
const input = () => host.querySelector('input') as HTMLInputElement
const click = (element: HTMLElement) => act(() => element.click())
const type = (element: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  host.remove()
})

describe('QuestionForm', () => {
  it('sends a single question on one tap, without repeating its title', () => {
    const onSubmit = setup([{ title: 'Which agent?', options: ['Codex', 'Claude'] }], { body: 'Pick one.' })
    expect(host.textContent).not.toContain('Which agent?')
    click(button('Claude'))
    expect(onSubmit).toHaveBeenCalledWith('Claude')
  })

  it('leaves out a free-form question the message text already says', () => {
    setup([{ title: 'What name?', options: [] }], { body: 'What name?' })
    expect(host.textContent).toBe('')
  })

  it('lists a free-form question the closing answer left out', () => {
    setup([{ title: 'What name?', options: [] }], { body: 'Tell me first.' })
    expect(host.textContent).toBe('What name?')
  })

  it('submits several answers together, once each one is given', () => {
    const onSubmit = setup(several)
    expect(button('Submit').disabled).toBe(true)
    click(button('Codex'))
    expect(button('Submit').disabled).toBe(true)
    type(input(), ' main ')
    expect(button('Submit').disabled).toBe(false)
    click(button('Submit'))
    expect(onSubmit).toHaveBeenCalledWith('Which agent?: Codex\nWhich branch?: main')
  })

  it('locks an answered form and shows what was answered', () => {
    setup(several, { answer: 'Which agent?: Claude\nWhich branch?: dev' })
    expect(button('Submit')).toBeUndefined()
    expect(button('Claude').getAttribute('aria-pressed')).toBe('true')
    expect(button('Codex').disabled).toBe(true)
    expect(input().value).toBe('dev')
  })
})
