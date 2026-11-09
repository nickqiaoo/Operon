// Real-browser regressions for operon's changes to the forked MessageScroller
// (see ../UPSTREAM.md). Kept apart from the upstream suites so those stay
// diffable against shadcn-ui/ui.
import * as React from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test } from "vitest"

import { MessageScroller as M, useMessageScroller } from "."

// Driven by rAF / ResizeObserver, which act() cannot wrap (see the upstream
// browser suite for the same opt-out).
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = false

const ITEM_HEIGHT = 80
const VIEWPORT_HEIGHT = 200

type Item = { id: string; height?: number; anchor?: boolean }

let root: Root | null = null
let container: HTMLDivElement | null = null
const loopErrors: string[] = []

function onWindowError(event: ErrorEvent) {
  if (event.message.includes("ResizeObserver loop")) {
    loopErrors.push(event.message)
    event.preventDefault()
  }
}

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
  loopErrors.length = 0
  window.removeEventListener("error", onWindowError)
})

function Thread({
  items,
  paddingTop = 0,
  paddingBottom = 0,
  extras = false,
  jumpTo,
  turnActive,
}: {
  items: Item[]
  paddingTop?: number
  paddingBottom?: number
  extras?: boolean
  jumpTo?: string
  turnActive?: boolean
}) {
  return (
    <M.Provider autoScroll turnActive={turnActive}>
      <M.Root>
        <M.Viewport
          aria-label="viewport"
          style={{ height: VIEWPORT_HEIGHT, overflowY: "auto" }}
        >
          <M.Content
            data-testid="content"
            style={{
              display: "flex",
              flexDirection: "column",
              paddingTop,
              paddingBottom,
            }}
          >
            {items.map((item) => (
              <M.Item
                key={item.id}
                messageId={item.id}
                scrollAnchor={item.anchor}
                style={{ height: item.height ?? ITEM_HEIGHT, flex: "none" }}
              >
                {item.height === 0 ? null : item.id}
              </M.Item>
            ))}
            {extras ? (
              <M.Item messageId="extras" style={{ flex: "none" }}>
                <div
                  data-testid="nested"
                  style={{ height: 60, overflowY: "auto" }}
                >
                  <div style={{ height: 300 }}>tall code block</div>
                </div>
                <input data-testid="field" />
                <button type="button" data-testid="control">
                  Expand
                </button>
              </M.Item>
            ) : null}
          </M.Content>
        </M.Viewport>
        <M.Button data-testid="scroll-to-end" />
        {jumpTo ? <JumpTo id={jumpTo} /> : null}
      </M.Root>
    </M.Provider>
  )
}

function JumpTo({ id }: { id: string }) {
  const { scrollToMessage } = useMessageScroller()
  return (
    <button
      type="button"
      data-testid="jump"
      onClick={() =>
        scrollToMessage(id, { behavior: "instant", scrollMargin: 12 })
      }
    >
      Jump
    </button>
  )
}

function settle(frames = 4) {
  return new Promise<void>((resolve) => {
    let remaining = frames
    const tick = () =>
      remaining-- <= 0 ? resolve() : requestAnimationFrame(tick)
    requestAnimationFrame(tick)
  })
}

function viewport() {
  return document.querySelector('[aria-label="viewport"]') as HTMLElement
}

function content() {
  return document.querySelector('[data-testid="content"]') as HTMLElement
}

function distanceToEnd(element = viewport()) {
  return Math.round(
    element.scrollHeight - element.clientHeight - element.scrollTop
  )
}

function items(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index}` }))
}

function rerender(props: React.ComponentProps<typeof Thread>) {
  flushSync(() => {
    root!.render(<Thread {...props} />)
  })
}

async function render(props: React.ComponentProps<typeof Thread>) {
  window.addEventListener("error", onWindowError)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  rerender(props)
  await settle()
}

/** Grow the last item, as a streamed chunk would. */
function grow(list: Item[], by: number): Item[] {
  return list.map((item, index) =>
    index === list.length - 1
      ? { ...item, height: (item.height ?? ITEM_HEIGHT) + by }
      : item
  )
}

/**
 * Read geometry from a ResizeObserver created after the scroller's own, so it
 * is delivered after them in the same batch: what it sees is what paints.
 */
function readAtNextDelivery<T>(target: Element, read: () => T) {
  return new Promise<T>((resolve) => {
    let initial = true
    const probe = new ResizeObserver(() => {
      // observe() queues an initial delivery for the current size.
      if (initial) {
        initial = false
        return
      }
      probe.disconnect()
      resolve(read())
    })
    probe.observe(target, { box: "border-box" })
  })
}

async function armProbe<T>(target: Element, read: () => T) {
  const result = readAtNextDelivery(target, read)
  // Let the probe consume its initial delivery (after this frame's rAF
  // callbacks) before the change under test.
  await settle(2)
  // Wrapped: returning the bare promise from this async function would make
  // the caller's await wait for the delivery the change has not caused yet.
  return { painted: result }
}

function lastItem() {
  const rows = content().querySelectorAll<HTMLElement>("[data-message-id]")
  return rows[rows.length - 1]!
}

function wheel(target: Element, deltaY: number, deltaX = 0) {
  target.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, deltaX, deltaY })
  )
}

test("pins a following viewport to the end before the grown chunk paints", async () => {
  let list = items(6)
  await render({ items: list })
  expect(distanceToEnd()).toBeLessThanOrEqual(1)

  // The growing row, not the content: that is what the chunk resizes.
  const { painted } = await armProbe(lastItem(), () => distanceToEnd())
  list = grow(list, 160)
  rerender({ items: list })

  expect(await painted).toBeLessThanOrEqual(1)
})

test("holds an anchored turn steady before the chunk that consumes its spacer paints", async () => {
  let list: Item[] = [...items(4), { id: "turn", anchor: true, height: 40 }]
  await render({ items: items(4) })
  rerender({ items: list })
  await settle()

  // While the reply fits in the reserved spacer, the scroll height must not
  // change: the spacer gives back exactly what the reply takes. Corrected a
  // frame late, every chunk painted once with the extra height (the
  // scrollbar thumb jumping).
  const scrollHeight = () => viewport().scrollHeight
  const before = scrollHeight()

  // The content's own height ends unchanged, so watch the reply row.
  const { painted } = await armProbe(lastItem(), scrollHeight)
  list = grow(list, 30)
  rerender({ items: list })

  expect(await painted).toBe(before)
  await settle()
  expect(loopErrors).toEqual([])
})

test("keeps following when content padding grows at the end", async () => {
  const list = items(6)
  await render({ items: list })

  rerender({ items: list, paddingBottom: 120 })
  await settle()

  expect(distanceToEnd()).toBeLessThanOrEqual(1)
})

test("a wheel toward the end while following does not release it", async () => {
  let list = items(6)
  await render({ items: list })

  wheel(viewport(), 120)
  await settle()
  list = grow(list, 200)
  rerender({ items: list })
  await settle()

  expect(distanceToEnd()).toBeLessThanOrEqual(1)
})

test("a sideways wheel does not release following", async () => {
  let list = items(6)
  await render({ items: list })

  wheel(viewport(), 0, 120)
  await settle()
  list = grow(list, 200)
  rerender({ items: list })
  await settle()

  expect(distanceToEnd()).toBeLessThanOrEqual(1)
})

test("a wheel a nested scroller takes does not release following", async () => {
  let list = items(6)
  await render({ items: list, extras: true })

  const nested = document.querySelector('[data-testid="nested"]') as HTMLElement
  nested.scrollTop = 100
  wheel(nested, -60)
  await settle()
  list = grow(list, 200)
  rerender({ items: list, extras: true })
  await settle()

  expect(distanceToEnd()).toBeLessThanOrEqual(1)
})

test("scroll keys typed into a field or on a control do not release following", async () => {
  let list = items(6)
  await render({ items: list, extras: true })

  const press = (testId: string, key: string) =>
    document
      .querySelector(`[data-testid="${testId}"]`)!
      .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }))
  // Every key edits the field. On a button only Space is taken (it activates
  // it); arrows and PageUp on a focused button still scroll the page.
  for (const key of ["ArrowUp", " ", "PageUp", "Home"]) press("field", key)
  press("control", " ")
  await settle()
  list = grow(list, 200)
  rerender({ items: list, extras: true })
  await settle()

  expect(distanceToEnd()).toBeLessThanOrEqual(1)
})

test("a finger pushing toward the end while following does not release it", async () => {
  let list = items(6)
  await render({ items: list })
  const target = viewport()

  const touchAt = (y: number) =>
    new Touch({ identifier: 1, target, clientX: 10, clientY: y })
  target.dispatchEvent(
    new TouchEvent("touchstart", { bubbles: true, touches: [touchAt(150)] })
  )
  // Finger moves up: content would scroll toward the end, already clamped.
  target.dispatchEvent(
    new TouchEvent("touchmove", { bubbles: true, touches: [touchAt(90)] })
  )
  await settle()
  list = grow(list, 200)
  rerender({ items: list })
  await settle()

  expect(distanceToEnd()).toBeLessThanOrEqual(1)
})

test("a finger pulling content down releases following", async () => {
  let list = items(6)
  await render({ items: list })
  const target = viewport()

  const touchAt = (y: number) =>
    new Touch({ identifier: 1, target, clientX: 10, clientY: y })
  target.dispatchEvent(
    new TouchEvent("touchstart", { bubbles: true, touches: [touchAt(90)] })
  )
  target.dispatchEvent(
    new TouchEvent("touchmove", { bubbles: true, touches: [touchAt(150)] })
  )
  target.scrollTop -= 60
  await settle()
  const scrollTop = target.scrollTop
  list = grow(list, 200)
  rerender({ items: list })
  await settle()

  expect(Math.round(target.scrollTop)).toBe(Math.round(scrollTop))
})

test("scrolling up in the same frame a chunk lands is not pulled back to the end", async () => {
  let list = items(6)
  await render({ items: list })
  const target = viewport()

  // The chunk is laid out but its resize not yet delivered when the reader's
  // wheel lands: the delivery that follows must not undo the scroll.
  list = grow(list, 200)
  rerender({ items: list })
  wheel(target, -100)
  target.scrollTop -= 100
  const scrollTop = target.scrollTop
  await settle()

  expect(Math.round(target.scrollTop)).toBe(Math.round(scrollTop))
  expect(distanceToEnd()).toBeGreaterThan(100)
})

test("a release stays until the reader scrolls back to the end", async () => {
  let list = items(6)
  await render({ items: list })
  const target = viewport()

  // The wheel's own scroll has not landed yet: commits in the meantime still
  // measure the end, and must not re-arm following. An appended empty row is
  // one such commit.
  wheel(target, -100)
  list = [...list, { id: "empty", height: 0 }]
  rerender({ items: list })
  await settle()
  list = grow(list, 200)
  rerender({ items: list })
  await settle()
  expect(distanceToEnd()).toBeGreaterThan(100)

  // Scrolling back down onto the end resumes following, even when an empty
  // streamed row is committed before the browser delivers the scroll event.
  target.scrollTop = target.scrollHeight
  list = [...list, { id: "next-reply", height: 0 }]
  rerender({ items: list })
  await settle()
  list = grow(list, 200)
  rerender({ items: list })
  await settle()
  expect(distanceToEnd()).toBeLessThanOrEqual(1)
})

test("reaching the live end during a gesture does not follow a new chunk", async () => {
  const list = items(6)
  await render({ items: list })
  const target = viewport()

  wheel(target, -60)
  target.scrollTop -= 60
  await settle()

  // A scrollTop assignment ends on its own in Chromium. Hold that event
  // while modeling a gesture that is still in progress.
  const holdScrollEnd = (event: Event) => event.stopImmediatePropagation()
  target.addEventListener("scrollend", holdScrollEnd, true)
  try {
    target.scrollTop = target.scrollHeight
    await settle()
    const end = target.scrollTop

    rerender({ items: grow(list, 100) })
    await settle()
    expect(target.scrollTop).toBe(end)
  } finally {
    target.removeEventListener("scrollend", holdScrollEnd, true)
  }

  target.dispatchEvent(new Event("scrollend"))
  rerender({ items: grow(list, 200) })
  await settle()
  expect(distanceToEnd()).toBe(200)
})

/** Older WebKit: the browser exposes no `scrollend`, and never fires one. */
function dropScrollEnd(target: HTMLElement) {
  const descriptor = Object.getOwnPropertyDescriptor(window, "onscrollend")
  Reflect.deleteProperty(window, "onscrollend")
  const hold = (event: Event) => event.stopImmediatePropagation()
  target.addEventListener("scrollend", hold, true)
  return () => {
    target.removeEventListener("scrollend", hold, true)
    if (descriptor) {
      Object.defineProperty(window, "onscrollend", descriptor)
    }
  }
}

function afterScrollSettles() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 250))
}

test("without scrollend, a reader back at the end stays pinned as the keyboard shrinks the viewport", async () => {
  await render({ items: items(6) })
  const target = viewport()
  const restore = dropScrollEnd(target)

  try {
    wheel(target, -60)
    target.scrollTop -= 60
    await settle()
    target.scrollTop = target.scrollHeight
    await settle()
    await afterScrollSettles()

    target.style.height = "120px"
    await settle()
    expect(distanceToEnd()).toBeLessThanOrEqual(1)
  } finally {
    restore()
  }
})

test("without scrollend, a finger still on the screen keeps the reader's place until it lifts", async () => {
  const list = items(6)
  await render({ items: list })
  const target = viewport()
  const restore = dropScrollEnd(target)
  const touch = new Touch({ identifier: 1, target, clientX: 10, clientY: 90 })

  try {
    wheel(target, -60)
    target.scrollTop -= 60
    await settle()

    target.dispatchEvent(
      new TouchEvent("touchstart", { bubbles: true, touches: [touch] })
    )
    target.scrollTop = target.scrollHeight
    await settle()
    await afterScrollSettles()
    const end = target.scrollTop
    rerender({ items: grow(list, 100) })
    await settle()
    expect(target.scrollTop).toBe(end)

    target.scrollTop = target.scrollHeight
    await settle()
    target.dispatchEvent(
      new TouchEvent("touchend", { bubbles: true, touches: [] })
    )
    await afterScrollSettles()
    rerender({ items: grow(list, 200) })
    await settle()
    expect(distanceToEnd()).toBeLessThanOrEqual(1)
  } finally {
    restore()
  }
})

test("a reader at the end who never resumed following stays at the end when the viewport shrinks", async () => {
  await render({ items: items(6) })
  const target = viewport()

  wheel(target, -60)
  target.scrollTop -= 60
  await settle()

  // scrollend exists here, but the follow never got re-armed by it.
  const hold = (event: Event) => event.stopImmediatePropagation()
  target.addEventListener("scrollend", hold, true)
  try {
    target.scrollTop = target.scrollHeight
    await settle()

    target.style.height = "120px"
    await settle()
    expect(distanceToEnd()).toBeLessThanOrEqual(1)
  } finally {
    target.removeEventListener("scrollend", hold, true)
  }
})

test("a reader up in the history keeps their place when the viewport shrinks", async () => {
  await render({ items: items(6) })
  const target = viewport()

  wheel(target, -120)
  target.scrollTop -= 120
  await settle()
  const top = target.scrollTop

  target.style.height = "120px"
  await settle()
  expect(Math.abs(target.scrollTop - top)).toBeLessThanOrEqual(1)
  expect(distanceToEnd()).toBeGreaterThan(100)
})

async function renderAnchoredShortTurn() {
  await render({ items: items(4) })
  rerender({ items: [...items(4), { id: "turn", anchor: true, height: 40 }] })
  await settle()
  const turn = document.querySelector('[data-message-id="turn"]') as HTMLElement
  const offset = () =>
    Math.round(
      turn.getBoundingClientRect().top - viewport().getBoundingClientRect().top
    )
  return { offset }
}

test("a wheel toward the end of an anchored short turn keeps the anchor", async () => {
  const { offset } = await renderAnchoredShortTurn()
  const before = offset()

  // The spacer holds the viewport at its max scrollTop: this moves nothing.
  wheel(viewport(), 120)
  await settle()
  rerender({ items: [...items(4), { id: "turn", anchor: true, height: 80 }] })
  await settle()
  expect(offset()).toBe(before)

  // Still anchored, so the reply filling the viewport hands off to following.
  rerender({ items: [...items(4), { id: "turn", anchor: true, height: 900 }] })
  await settle()
  expect(distanceToEnd()).toBeLessThanOrEqual(1)
})

test("scrolling up from a short turn moves it only by the scroll distance", async () => {
  const { offset } = await renderAnchoredShortTurn()
  const target = viewport()
  const before = offset()

  wheel(target, -12)
  target.scrollTop -= 12
  await settle()
  expect(offset()).toBe(before + 12)

  wheel(target, -12)
  target.scrollTop -= 12
  await settle()
  expect(offset()).toBe(before + 24)

  rerender({ items: [...items(4), { id: "turn", anchor: true, height: 80 }] })
  await settle()
  expect(offset()).toBe(before + 24)

  // Real content still ends inside the viewport; only the spacer is below.
  expect(distanceToEnd(target)).toBe(24)
  // The scroller mirrors its published state onto the viewport.
  expect(target.getAttribute("data-scrollable") ?? "").toContain("end")
  const button = document.querySelector('[data-testid="scroll-to-end"]')
  expect(button?.getAttribute("data-active")).toBe("false")

  // Growing the reply beyond the viewport reveals the button without changing
  // the reader's scroll position or the existing reading state.
  rerender({ items: [...items(4), { id: "turn", anchor: true, height: 300 }] })
  await settle()
  expect(offset()).toBe(before + 24)
  expect(button?.getAttribute("data-active")).toBe("true")
})

test("a finished short reply keeps its position and loses its blank scroll range once read back", async () => {
  const { offset } = await renderAnchoredShortTurn()
  const list = [
    ...items(4),
    { id: "turn", anchor: true, height: 40 },
    { id: "reply", height: 24 },
  ]
  rerender({ items: list, turnActive: true })
  await settle()
  const target = viewport()
  const hasContentBelow = () => target.getAttribute("data-scrollable")?.includes("end")
  const before = offset()

  wheel(target, -20)
  target.scrollTop -= 20
  await settle()
  expect(hasContentBelow()).toBe(true)

  rerender({ items: list, turnActive: false })
  await settle()
  expect(offset()).toBe(before + 20)
  expect(hasContentBelow()).toBe(false)

  // Read far enough back for the transcript itself to extend below the viewport.
  const naturalEnd = 4 * ITEM_HEIGHT + 40 + 24 - VIEWPORT_HEIGHT
  wheel(target, -160)
  target.scrollTop = naturalEnd - 40
  await settle()
  expect(target.scrollTop).toBe(naturalEnd - 40)
  expect(hasContentBelow()).toBe(true)

  // Even a scroll beyond the end cannot bring the blank area back.
  target.scrollTop = target.scrollHeight
  await settle()
  expect(target.scrollTop).toBe(naturalEnd)
  expect(hasContentBelow()).toBe(false)
})

test("the first reply respects a native scroll away from the waiting turn", async () => {
  const { offset } = await renderAnchoredShortTurn()
  const target = viewport()
  const before = offset()

  // A scrollbar drag moves the viewport without a wheel or touch event.
  target.scrollTop -= 30
  rerender({ items: [
    ...items(4),
    { id: "turn", anchor: true, height: 40 },
    { id: "reply", height: 250 },
  ] })
  await settle()

  expect(offset()).toBe(before + 30)
  expect(distanceToEnd()).toBeGreaterThan(30)
})

test("the first reply consuming the spacer does not resume follow during a scroll", async () => {
  await renderAnchoredShortTurn()
  const target = viewport()
  const end = target.scrollTop

  wheel(target, -24)
  target.scrollTop -= 24
  await settle()
  wheel(target, 19)
  target.scrollTop += 19
  await settle()

  // The first reply exactly fills the spacer while the reader is still just
  // above the end. Subsequent text must not pull them down.
  const list = [
    ...items(4),
    { id: "turn", anchor: true, height: 40 },
    { id: "reply", height: VIEWPORT_HEIGHT - 64 - 40 },
  ]
  rerender({ items: list })
  await settle()
  rerender({ items: grow(list, 100) })
  await settle()

  expect(target.scrollTop).toBe(end - 5)
})

test("a settling jump keeps its row in place while rows around it settle", async () => {
  let list = items(12)
  await render({ items: list, jumpTo: "m6" })
  ;(document.querySelector('[data-testid="jump"]') as HTMLButtonElement).click()
  await settle()

  const row = () => document.querySelector('[data-message-id="m6"]') as HTMLElement
  const offset = () =>
    Math.round(
      row().getBoundingClientRect().top - viewport().getBoundingClientRect().top
    )
  const before = offset()

  // Rows above it and the row itself settle to other heights a few frames
  // later (estimated content-visibility sizes turning real).
  list = list.map((item, index) =>
    index >= 3 && index <= 6 ? { ...item, height: ITEM_HEIGHT - 30 } : item
  )
  rerender({ items: list, jumpTo: "m6" })
  await settle()

  expect(offset()).toBe(before)
})

test("a settling jump keeps its row in place when an inset is measured after it", async () => {
  await render({ items: items(12), jumpTo: "m6" })
  ;(document.querySelector('[data-testid="jump"]') as HTMLButtonElement).click()
  await settle()

  const row = document.querySelector('[data-message-id="m6"]') as HTMLElement
  const offset = () =>
    Math.round(
      row.getBoundingClientRect().top - viewport().getBoundingClientRect().top
    )
  const before = offset()

  // A header floating over the transcript is measured and padded in late.
  rerender({ items: items(12), jumpTo: "m6", paddingTop: 100 })
  await settle()

  expect(offset()).toBe(before)
})

test("a free reader keeps their row while rows above it settle to other heights", async () => {
  let list = items(12)
  await render({ items: list })
  const target = viewport()

  // Read up in the history.
  wheel(target, -300)
  target.scrollTop = 5 * ITEM_HEIGHT + 20
  await settle()

  const row = () => document.querySelector('[data-message-id="m6"]') as HTMLElement
  const offset = () =>
    Math.round(row().getBoundingClientRect().top - target.getBoundingClientRect().top)
  const before = offset()

  // Rows above settle from estimated heights (content-visibility): one grows,
  // the others shrink, 60px net.
  list = list.map((item, index) =>
    index === 1
      ? { ...item, height: ITEM_HEIGHT + 120 }
      : index >= 2 && index <= 4
        ? { ...item, height: ITEM_HEIGHT - 20 }
        : item
  )
  rerender({ items: list })
  await settle()
  expect(offset()).toBe(before)

  // Older history mounting above keeps it in place too.
  list = [{ id: "older-a" }, { id: "older-b", height: 150 }, ...list]
  rerender({ items: list })
  await settle()
  expect(offset()).toBe(before)
})
