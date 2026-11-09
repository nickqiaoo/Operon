import * as React from "react"

import { composeRefs, mergeProps, useRender } from "../use-render"
import {
  SCROLL_END_FALLBACK_DELAY,
  SCROLL_POSITION_EPSILON,
  USER_SCROLL_KEYS,
} from "./types"
import type {
  MessageScrollerButtonProps,
  MessageScrollerContentProps,
  MessageScrollerContextValue,
  MessageScrollerItemProps,
  MessageScrollerProps,
  MessageScrollerProviderProps,
  MessageScrollerRegisterMessage,
  MessageScrollerScrollable,
  MessageScrollerViewportProps,
} from "./types"
import { useMessageScrollerController } from "./use-message-scroller-controller"
import { useLatest } from "./utils"

const MessageScrollerContext =
  React.createContext<MessageScrollerContextValue | null>(null)
const MessageScrollerItemContext =
  React.createContext<MessageScrollerRegisterMessage | null>(null)

function useMessageScrollerContext() {
  const context = React.useContext(MessageScrollerContext)

  if (!context) {
    throw new Error("useMessageScroller must be used within a MessageScroller.")
  }

  return context
}

function useMessageScrollerItemContext() {
  const context = React.useContext(MessageScrollerItemContext)

  if (!context) {
    throw new Error(
      "MessageScrollerItem must be used within a MessageScroller."
    )
  }

  return context
}

function useMessageScroller() {
  const { scrollToEnd, scrollToMessage, scrollToStart, stopFollowing } =
    useMessageScrollerContext()

  return React.useMemo(
    () => ({
      scrollToEnd,
      scrollToMessage,
      scrollToStart,
      stopFollowing,
    }),
    [scrollToEnd, scrollToMessage, scrollToStart, stopFollowing]
  )
}

function useMessageScrollerScrollable(field: keyof MessageScrollerScrollable): boolean
function useMessageScrollerScrollable(): MessageScrollerScrollable
function useMessageScrollerScrollable(field?: keyof MessageScrollerScrollable) {
  const { stateStore } = useMessageScrollerContext()
  const getSnapshot = React.useCallback(() => {
    const state = stateStore.getSnapshot()
    return field ? state[field] : state
  }, [field, stateStore])

  return React.useSyncExternalStore(
    stateStore.subscribe,
    getSnapshot,
    getSnapshot
  )
}

function useMessageScrollerVisibility() {
  const { observeVisibility, unobserveVisibility, visibilityStore } =
    useMessageScrollerContext()
  const subscribe = React.useCallback(
    (listener: () => void) =>
      visibilityStore.subscribe(
        listener,
        observeVisibility,
        unobserveVisibility
      ),
    [observeVisibility, unobserveVisibility, visibilityStore]
  )

  return React.useSyncExternalStore(
    subscribe,
    visibilityStore.getSnapshot,
    visibilityStore.getSnapshot
  )
}

function MessageScrollerProvider({
  autoScroll = false,
  children,
  defaultScrollPosition = "end",
  scrollEdgeThreshold,
  scrollPreviousItemPeek,
  scrollMargin,
  turnActive,
}: MessageScrollerProviderProps) {
  const { context, registerMessage } = useMessageScrollerController({
    autoScroll,
    defaultScrollPosition,
    scrollEdgeThreshold,
    scrollPreviousItemPeek,
    scrollMargin,
    turnActive,
  })

  return (
    <MessageScrollerContext.Provider value={context}>
      <MessageScrollerItemContext.Provider value={registerMessage}>
        {children}
      </MessageScrollerItemContext.Provider>
    </MessageScrollerContext.Provider>
  )
}

function usePendingDefaultScroll() {
  const { pendingDefaultScrollStore } = useMessageScrollerContext()

  return React.useSyncExternalStore(
    pendingDefaultScrollStore.subscribe,
    pendingDefaultScrollStore.getSnapshot,
    pendingDefaultScrollStore.getSnapshot
  )
}

function MessageScroller({ children, ...props }: MessageScrollerProps) {
  const { setRootElement } = useMessageScrollerContext()
  const pendingDefaultScroll = usePendingDefaultScroll()

  return (
    <div
      ref={setRootElement}
      {...props}
      {...(pendingDefaultScroll ? { "data-pending-scroll": "" } : null)}
    >
      {children}
    </div>
  )
}

// [operon] Which way a gesture would move the viewport: -1 toward the start,
// 1 toward the end, 0 nowhere. Mirrors the browser's own routing: a mostly
// sideways gesture does not scroll vertically, a scrollable descendant (a tall
// code block) that can still move in that direction takes the scroll before it
// chains out, and a viewport already at that edge does not move at all (an
// anchored turn's spacer holds the viewport at its max scrollTop too).
function getGestureDirection(
  target: EventTarget | null,
  viewport: HTMLElement,
  deltaX: number,
  deltaY: number
) {
  if (Math.abs(deltaX) > Math.abs(deltaY)) {
    return 0
  }

  if (deltaY === 0) {
    return undefined
  }

  const direction = deltaY < 0 ? -1 : 1
  const canMove = (element: HTMLElement) =>
    direction < 0
      ? element.scrollTop > SCROLL_POSITION_EPSILON
      : element.scrollTop + element.clientHeight <
        element.scrollHeight - SCROLL_POSITION_EPSILON

  for (
    let element = target instanceof Element ? target : null;
    element && element !== viewport;
    element = element.parentElement
  ) {
    if (!(element instanceof HTMLElement)) {
      continue
    }

    const { overflowY } = getComputedStyle(element)

    if ((overflowY === "auto" || overflowY === "scroll") && canMove(element)) {
      return 0
    }
  }

  return canMove(viewport) ? direction : 0
}

// A function so that lib.dom's always-present `onscrollend` does not narrow
// `window` to `never` at the call site.
function hasScrollEndEvent(): boolean {
  return "onscrollend" in window
}

// [operon] Keys typed into a field, or Space/Enter on a control, do not scroll.
function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

function isActivationTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    target.closest("button, a[href], summary, [role='button']") !== null
  )
}

function getKeyDirection(event: React.KeyboardEvent<HTMLDivElement>) {
  if (isTypingTarget(event.target)) {
    return 0
  }

  switch (event.key) {
    case "ArrowUp":
    case "PageUp":
    case "Home":
      return -1
    case "ArrowDown":
    case "PageDown":
    case "End":
      return 1
    case " ":
      if (event.target !== event.currentTarget && isActivationTarget(event.target)) {
        return 0
      }

      return event.shiftKey ? -1 : 1
    default:
      return undefined
  }
}

function MessageScrollerViewport({
  "aria-label": ariaLabel,
  children,
  onKeyDown,
  onScroll,
  onTouchCancel,
  onTouchEnd,
  onTouchMove,
  onTouchStart,
  onWheel,
  preserveScrollOnPrepend = true,
  ref,
  role,
  style,
  tabIndex,
  ...props
}: MessageScrollerViewportProps) {
  const {
    handleResize,
    handleScrollEnd,
    preserveScrollOnPrependRef,
    setViewportElement,
    syncAfterScroll,
    userScrollIntent,
    viewportRef,
  } = useMessageScrollerContext()
  const pendingDefaultScroll = usePendingDefaultScroll()

  preserveScrollOnPrependRef.current = preserveScrollOnPrepend

  const setViewportRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      setViewportElement(element)
      composeRefs(ref)?.(element)
    },
    [ref, setViewportElement]
  )

  // [operon] Where there is no `scrollend`, scrolling has ended once the finger
  // is up and scroll events have stopped. Without this a reader who scrolled
  // away could never resume following by scrolling back.
  const touchActiveRef = React.useRef(false)
  const scrollEndTimerRef = React.useRef<number | null>(null)

  function scheduleScrollEndFallback() {
    if (hasScrollEndEvent()) {
      return
    }

    if (scrollEndTimerRef.current !== null) {
      window.clearTimeout(scrollEndTimerRef.current)
    }

    scrollEndTimerRef.current = window.setTimeout(() => {
      scrollEndTimerRef.current = null

      if (!touchActiveRef.current) {
        handleScrollEnd()
      }
    }, SCROLL_END_FALLBACK_DELAY)
  }

  React.useEffect(
    () => () => {
      if (scrollEndTimerRef.current !== null) {
        window.clearTimeout(scrollEndTimerRef.current)
        scrollEndTimerRef.current = null
      }
    },
    []
  )

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    syncAfterScroll()
    scheduleScrollEndFallback()
    onScroll?.(event)
  }

  function handleTouchFinished(event: React.TouchEvent<HTMLDivElement>) {
    touchActiveRef.current = event.touches.length > 0
    scheduleScrollEndFallback()
  }

  function handleTouchEnd(event: React.TouchEvent<HTMLDivElement>) {
    handleTouchFinished(event)
    onTouchEnd?.(event)
  }

  function handleTouchCancel(event: React.TouchEvent<HTMLDivElement>) {
    handleTouchFinished(event)
    onTouchCancel?.(event)
  }

  // [operon] Last touch point, so a touchmove knows which way the finger went.
  const touchPointRef = React.useRef<{ x: number; y: number } | null>(null)

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    userScrollIntent(
      getGestureDirection(
        event.target,
        event.currentTarget,
        event.deltaX,
        event.deltaY
      )
    )
    onWheel?.(event)
  }

  function handleTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0]
    touchActiveRef.current = true
    touchPointRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null
    onTouchStart?.(event)
  }

  function handleTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0]
    const previous = touchPointRef.current

    if (touch && previous) {
      touchPointRef.current = { x: touch.clientX, y: touch.clientY }
      // A finger moving down drags content down: the viewport moves toward
      // the start. Scroll deltas are the opposite of the finger's motion.
      userScrollIntent(
        getGestureDirection(
          event.target,
          event.currentTarget,
          previous.x - touch.clientX,
          previous.y - touch.clientY
        )
      )
    } else {
      userScrollIntent()
    }

    onTouchMove?.(event)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (USER_SCROLL_KEYS.has(event.key)) {
      userScrollIntent(getKeyDirection(event))
    }

    onKeyDown?.(event)
  }

  React.useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport || typeof ResizeObserver === "undefined") {
      return
    }

    // [operon] Correct during delivery, before paint: deferring to the next
    // frame painted one frame at the old offset on every resize (a keyboard
    // opening, a side panel narrowing the transcript). Any spacer this mutates
    // sits inside the content, which is deeper than the viewport, so the
    // content observer still receives it in this same delivery.
    const observer = new ResizeObserver(() => {
      handleResize()
    })

    observer.observe(viewport)

    return () => {
      observer.disconnect()
    }
  }, [handleResize, viewportRef])

  // [operon] Native listener: scrollend support in React's event system lags.
  React.useEffect(() => {
    const viewport = viewportRef.current

    if (!viewport) {
      return
    }

    viewport.addEventListener("scrollend", handleScrollEnd)

    return () => viewport.removeEventListener("scrollend", handleScrollEnd)
  }, [handleScrollEnd, viewportRef])

  return (
    <div
      ref={setViewportRef}
      role={role ?? "region"}
      aria-label={ariaLabel ?? "Messages"}
      tabIndex={tabIndex ?? 0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      onTouchCancel={handleTouchCancel}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onTouchStart={handleTouchStart}
      onWheel={handleWheel}
      // [operon] The scroller preserves the reading position itself (by content
      // offset); the browser's own scroll anchoring would apply the same shift
      // a second time.
      style={{ overflowAnchor: "none", ...style }}
      {...props}
      {...(pendingDefaultScroll ? { "data-pending-scroll": "" } : null)}
    >
      {children}
    </div>
  )
}

function MessageScrollerContent({
  "aria-relevant": ariaRelevant,
  children,
  ref,
  role,
  spacerClassName,
  ...props
}: MessageScrollerContentProps) {
  const {
    handleContentChange,
    handleResize,
    setContentElement,
    setSpacerElement,
  } = useMessageScrollerContext()
  const contentRef = React.useRef<HTMLDivElement | null>(null)

  const setContentRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element
      setContentElement(element)
      composeRefs(ref)?.(element)
    },
    [ref, setContentElement]
  )

  React.useLayoutEffect(() => {
    const content = contentRef.current

    if (!content) {
      return
    }

    handleContentChange()

    if (typeof MutationObserver === "undefined") {
      return
    }

    const observer = new MutationObserver(() => {
      handleContentChange()
    })

    observer.observe(content, { childList: true })

    return () => observer.disconnect()
  }, [handleContentChange])

  React.useEffect(() => {
    const content = contentRef.current

    if (!content || typeof ResizeObserver === "undefined") {
      return
    }

    // [operon] Correct during delivery, before paint. Deferring to the next
    // frame painted every streamed chunk once at the stale offset: a follow
    // gap below the reply, or an anchored turn's scroll height wobbling.
    //
    // Border box, so a padding change (insets for chrome floating over the
    // transcript) is seen too.
    //
    // handleResize may resize this very element (it rewrites the tail spacer
    // while holding an anchored turn or draining a released spacer). Resizing
    // an observed element inside its own delivery would end the delivery with
    // "ResizeObserver loop completed with undelivered notifications", so when
    // that happens observation is suspended and resumed on the next frame.
    // observe() queues an initial delivery; the remembered height lets it
    // settle unless the content really changed while suspended.
    let frame = 0
    let disposed = false
    let observedHeight = content.getBoundingClientRect().height

    const observer = new ResizeObserver(() => {
      const deliveredHeight = content.getBoundingClientRect().height

      if (Math.abs(deliveredHeight - observedHeight) <= SCROLL_POSITION_EPSILON) {
        return
      }

      handleResize()
      observedHeight = content.getBoundingClientRect().height

      if (Math.abs(observedHeight - deliveredHeight) > SCROLL_POSITION_EPSILON) {
        observer.unobserve(content)
        window.cancelAnimationFrame(frame)
        frame = window.requestAnimationFrame(() => {
          if (!disposed && content.isConnected) {
            observer.observe(content, { box: "border-box" })
          }
        })
      }
    })

    observer.observe(content, { box: "border-box" })

    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [handleResize])

  return (
    <div
      ref={setContentRef}
      role={role ?? "log"}
      aria-relevant={ariaRelevant ?? "additions"}
      {...props}
    >
      {children}
      <div
        ref={setSpacerElement}
        aria-hidden="true"
        data-message-scroller-spacer=""
        hidden
        className={spacerClassName}
      />
    </div>
  )
}

function MessageScrollerItem({
  messageId,
  ref,
  scrollAnchor = false,
  ...props
}: MessageScrollerItemProps) {
  const registerMessage = useMessageScrollerItemContext()
  const elementRef = React.useRef<HTMLDivElement | null>(null)

  const setItemRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      const previousElement = elementRef.current

      elementRef.current = element

      if (messageId) {
        registerMessage(messageId, element, previousElement)
      }

      composeRefs(ref)?.(element)
    },
    [messageId, ref, registerMessage]
  )

  return (
    <div
      ref={setItemRef}
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor ? "true" : "false"}
      {...props}
    />
  )
}

function MessageScrollerButton({
  behavior = "smooth",
  children,
  direction = "end",
  onClick,
  render,
  tabIndex,
  type = "button",
  ...props
}: MessageScrollerButtonProps) {
  const { scrollToEnd, scrollToStart } = useMessageScrollerContext()
  const onClickRef = useLatest(onClick)
  const isActive = useMessageScrollerScrollable(direction === "start" ? "start" : "hasContentBelow")

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!isActive) {
        return
      }

      onClickRef.current?.(event)

      if (!event.defaultPrevented) {
        event.currentTarget.blur()

        if (direction === "start") {
          scrollToStart({ behavior })
        } else {
          scrollToEnd({ behavior })
        }
      }
    },
    [behavior, direction, isActive, onClickRef, scrollToEnd, scrollToStart]
  )

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        type,
        inert: !isActive,
        tabIndex: isActive ? tabIndex : -1,
        children: children ?? <span>Scroll to {direction}</span>,
        onClick: handleClick,
      },
      props
    ),
    render,
    state: {
      active: isActive,
      direction,
    },
    stateAttributesMapping: {
      active: (value) => ({
        "data-active": value ? "true" : "false",
      }),
    },
  })
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
