import * as React from "react"

import {
  getContentBottom,
  getElementScrollTop,
  getElementTop,
  getElementViewportTop,
  getFirstVisibleMessageItem,
  getFlexGap,
  getLastScrollAnchor,
  getMaxScrollTop,
  getMessageScrollerItems,
  getMessageScrollerScrollable,
  getMessageScrollerVisibilityState,
  getNewScrollAnchor,
  getTailSpacerHeight,
  getUnanchoredScrollAnchor,
  hasMultipleNewScrollAnchors,
} from "./geometry"
import {
  DEFAULT_SCROLL_EDGE_THRESHOLD,
  DEFAULT_SCROLL_MARGIN,
  DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
  EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE,
  SCROLL_POSITION_EPSILON,
} from "./types"
import type {
  MessageScrollerContextValue,
  MessageScrollerProviderProps,
  MessageScrollerRegisterMessage,
  MessageScrollerScrollable,
} from "./types"
import { useMessageScrollerCommands } from "./use-message-scroller-commands"
import {
  clearPendingDefaultScroll,
  markDefaultScrollPositionApplied,
  useMessageScrollerRefs,
} from "./use-message-scroller-refs"

// Builds a ref callback that stores the node and runs onMount once it attaches.
function useElementRef(
  elementRef: React.RefObject<HTMLDivElement | null>,
  onMount: () => void
) {
  return React.useCallback(
    (element: HTMLDivElement | null) => {
      elementRef.current = element

      if (element) {
        onMount()
      }
    },
    [elementRef, onMount]
  )
}

// Orchestrator hook. Decides when to scroll and delegates the moves to
// useMessageScrollerCommands; state and visibility commits are coalesced on a
// requestAnimationFrame and torn down on cleanup for StrictMode safety.
function useMessageScrollerController({
  autoScroll = false,
  defaultScrollPosition = "end",
  scrollEdgeThreshold = DEFAULT_SCROLL_EDGE_THRESHOLD,
  scrollPreviousItemPeek = DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
  scrollMargin = DEFAULT_SCROLL_MARGIN,
  turnActive = true,
}: MessageScrollerProviderProps) {
  const refs = useMessageScrollerRefs({
    autoScroll,
    defaultScrollPosition,
    scrollEdgeThreshold,
    scrollMargin,
    scrollPreviousItemPeek,
  })

  const {
    streamingTurnRef,
    autoScrollRef,
    autoscrollingRef,
    autoscrollingTimeoutRef,
    contentRef,
    defaultScrollPositionAppliedRef,
    firstItemRef,
    itemCountRef,
    lastScrollTopRef,
    messageElementsRef,
    modeRef,
    pendingFollowOnScrollEndRef,
    pendingScrollFrameRef,
    pendingScrollToMessageRef,
    prependRestoreRef,
    preserveScrollOnPrependRef,
    readingAnchorRef,
    smoothScrollRef,
    pendingDefaultScrollStore,
    rootRef,
    scrollEdgeThresholdRef,
    scrollMarginRef,
    scrollPreviousItemPeekRef,
    spacerGapRef,
    spacerHeightRef,
    spacerRef,
    stateFrameRef,
    stateStore,
    userReleasedFollowRef,
    viewportRef,
    visibilityFrameRef,
    visibilityObserverRef,
    visibilityStore,
    visibleMessageIdsRef,
    handledScrollAnchorsRef,
  } = refs

  const turnActiveRef = React.useRef(turnActive)
  turnActiveRef.current = turnActive

  const previousDefaultScrollPositionRef = React.useRef(defaultScrollPosition)

  if (previousDefaultScrollPositionRef.current !== defaultScrollPosition) {
    previousDefaultScrollPositionRef.current = defaultScrollPosition
    defaultScrollPositionAppliedRef.current = false
    // The pending-scroll hold is mount-only. A live prop change re-applies the
    // opening position in layout; it does not hide the viewport again.
  }

  const writeStateAttributes = React.useCallback(
    (state: MessageScrollerScrollable) => {
      const root = rootRef.current
      const viewport = viewportRef.current
      const scrollable = [state.start && "start", state.end && "end"]
        .filter(Boolean)
        .join(" ")
      const autoScrolling = autoscrollingRef.current

      for (const element of [root, viewport]) {
        if (!element) {
          continue
        }

        if (scrollable) {
          element.setAttribute("data-scrollable", scrollable)
        } else {
          element.removeAttribute("data-scrollable")
        }

        element.toggleAttribute("data-autoscrolling", autoScrolling)
      }
    },
    []
  )

  // Owns the one follow-bottom transition: arm at the bottom, release on any
  // scroll away (including a scrollbar drag), suppressed during a programmatic
  // scroll so the auto-scroll animation cannot release itself. Arming also
  // skips the anchored-to-message hold: the tail spacer makes a freshly
  // anchored turn read as "at the end", and re-arming there would let the
  // first streamed chunk yank the reader off the anchor. The hold hands back
  // to following in handleResize, once the reply consumes the tail spacer.
  const reconcileFollowMode = React.useCallback(
    (hasContentBelow: boolean) => {
      const viewport = viewportRef.current
      if (!viewport) {
        return
      }

      const scrollTop = viewport.scrollTop
      // Growth can open a gap below the viewport before resize is delivered.
      // Release only when scrollTop moved away from the previous scroll position.
      const scrolledUp =
        scrollTop < lastScrollTopRef.current - SCROLL_POSITION_EPSILON

      // [operon] A scrollbar drag can leave an anchored turn without a wheel
      // or touch event. A layout shrink can also move scrollTop upward, but
      // only by clamping it to the end.
      if (
        modeRef.current === "anchored-to-message" &&
        scrolledUp &&
        scrollTop < getMaxScrollTop(viewport) - SCROLL_POSITION_EPSILON
      ) {
        modeRef.current = "free-scrolling"
        userReleasedFollowRef.current = true
      }

      if (
        autoScrollRef.current &&
        !hasContentBelow &&
        spacerHeightRef.current === 0 &&
        !userReleasedFollowRef.current &&
        modeRef.current !== "settling-jump" &&
        modeRef.current !== "anchored-to-message"
      ) {
        modeRef.current = "following-bottom"
      } else if (
        modeRef.current === "following-bottom" &&
        hasContentBelow &&
        scrolledUp &&
        !autoscrollingRef.current
      ) {
        modeRef.current = "free-scrolling"
        userReleasedFollowRef.current = true
      }
    },
    []
  )

  const commitScrollState = React.useCallback(() => {
    const nextState = getMessageScrollerScrollable({
      content: contentRef.current,
      scrollEdgeThreshold: scrollEdgeThresholdRef.current,
      spacer: spacerRef.current,
      viewport: viewportRef.current,
    })

    reconcileFollowMode(nextState.end)

    // While follow-output is engaged the scroller is already closing any gap a
    // streamed chunk just opened. Suppress that transient gap for the button.
    const hasContentBelow = modeRef.current !== "following-bottom" && nextState.end
    // A released spacer still marks a reader as away from the live position
    // for new-turn anchoring, even when there is nothing for the button to reveal.
    const releasedSpacer =
      modeRef.current === "free-scrolling" &&
      spacerHeightRef.current > 0 &&
      (turnActiveRef.current || !streamingTurnRef.current)
    const publishedState = {
      start: nextState.start,
      end: hasContentBelow || releasedSpacer,
      hasContentBelow,
    }

    writeStateAttributes(publishedState)
    stateStore.setSnapshot(publishedState)
  }, [reconcileFollowMode, stateStore, writeStateAttributes])

  const scheduleStateCommit = React.useCallback(() => {
    if (stateFrameRef.current !== null) {
      return
    }

    stateFrameRef.current = window.requestAnimationFrame(() => {
      stateFrameRef.current = null
      commitScrollState()
    })
  }, [commitScrollState])

  const scheduleVisibilitySync = React.useCallback(() => {
    if (!visibilityStore.hasListeners()) {
      return
    }

    if (visibilityFrameRef.current !== null) {
      return
    }

    visibilityFrameRef.current = window.requestAnimationFrame(() => {
      visibilityFrameRef.current = null

      // A frame can outlive the last unsubscribe. Recomputing here would
      // overwrite the EMPTY snapshot that teardown just wrote, leaving a stale
      // value for the next subscriber to read.
      if (!visibilityStore.hasListeners()) {
        return
      }

      visibilityStore.setSnapshot(
        getMessageScrollerVisibilityState({
          content: contentRef.current,
          scrollMargin: scrollMarginRef.current,
          scrollPreviousItemPeek: scrollPreviousItemPeekRef.current,
          spacer: spacerRef.current,
          viewport: viewportRef.current,
          visibleMessageIds: visibleMessageIdsRef.current,
        })
      )
    })
  }, [visibilityStore])

  const {
    flushPendingScrollToMessage,
    holdJumpTarget,
    reanchorToAnchoredMessage,
    scrollToElement,
    scrollToEnd,
    scrollToMessage,
    scrollToStart,
    setTailSpacerHeight,
  } = useMessageScrollerCommands({
    refs,
    commitScrollState,
    scheduleStateCommit,
    scheduleVisibilitySync,
  })

  // [operon] Reading-position preservation for a reader who is not being
  // followed, held or jumped: keep the first visible row where it is while
  // anything above it changes - older history mounting, rows settling from
  // estimated heights (content-visibility), insets changing. Upstream only
  // restored on a prepend, by viewport offset; this covers every layout shift,
  // by content offset, and replaces that restore while reading.
  const isReading = React.useCallback(
    () =>
      preserveScrollOnPrependRef.current &&
      !smoothScrollRef.current &&
      (modeRef.current === "free-scrolling" ||
        (modeRef.current === "following-bottom" && !autoScrollRef.current)),
    []
  )

  const captureReadingAnchor = React.useCallback(() => {
    const content = contentRef.current
    const viewport = viewportRef.current

    if (!content || !viewport || !isReading()) {
      readingAnchorRef.current = null
      return
    }

    const element = getFirstVisibleMessageItem({
      content,
      spacer: spacerRef.current,
      viewport,
    })

    readingAnchorRef.current = element
      ? { element, top: getElementTop(element, viewport) }
      : null
  }, [isReading])

  const restoreReadingAnchor = React.useCallback(() => {
    const anchor = readingAnchorRef.current
    const viewport = viewportRef.current

    if (
      !anchor ||
      !viewport ||
      !anchor.element.isConnected ||
      !isReading()
    ) {
      return false
    }

    const top = getElementTop(anchor.element, viewport)
    const delta = top - anchor.top

    if (Math.abs(delta) <= SCROLL_POSITION_EPSILON) {
      return false
    }

    const scrollTop = viewport.scrollTop
    viewport.scrollTop = scrollTop + delta
    // Offset the baseline by the applied correction, leaving the reader's
    // own movement detectable when the scroll event is delivered.
    lastScrollTopRef.current += viewport.scrollTop - scrollTop
    anchor.top = getElementTop(anchor.element, viewport)
    scheduleStateCommit()
    scheduleVisibilitySync()

    return true
  }, [isReading, scheduleStateCommit, scheduleVisibilitySync])

  const restorePrependedAnchor = React.useCallback(() => {
    const anchor = prependRestoreRef.current
    const viewport = viewportRef.current

    if (!anchor || !viewport || !anchor.element.isConnected) {
      return false
    }

    // Compare the anchor relative to the viewport, not to the content. Native
    // scroll anchoring leaves the viewport-relative position unchanged, so this
    // is a no-op where the browser already handled the prepend and only corrects
    // the scroll where it did not (e.g. Safari) — without trusting a capability
    // flag, which some engines report incorrectly.
    const nextViewportTop = getElementViewportTop(anchor.element, viewport)
    const delta = nextViewportTop - anchor.viewportTop

    if (Math.abs(delta) <= SCROLL_POSITION_EPSILON) {
      return false
    }

    const scrollTop = viewport.scrollTop
    viewport.scrollTop = scrollTop + delta
    lastScrollTopRef.current += viewport.scrollTop - scrollTop
    anchor.viewportTop = getElementViewportTop(anchor.element, viewport)
    scheduleStateCommit()
    scheduleVisibilitySync()

    return true
  }, [scheduleStateCommit, scheduleVisibilitySync])

  const capturePrependAnchor = React.useCallback(() => {
    const content = contentRef.current
    const viewport = viewportRef.current

    if (!content || !viewport) {
      prependRestoreRef.current = null
      return
    }

    const anchor = getFirstVisibleMessageItem({
      content,
      spacer: spacerRef.current,
      viewport,
    })

    prependRestoreRef.current = anchor
      ? {
          element: anchor,
          viewportTop: getElementViewportTop(anchor, viewport),
        }
      : null
  }, [])

  const schedulePendingScrollToMessageFlush = React.useCallback(() => {
    if (pendingScrollFrameRef.current !== null) {
      return
    }

    pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingScrollFrameRef.current = null

      if (flushPendingScrollToMessage()) {
        capturePrependAnchor()
      }
    })
  }, [capturePrependAnchor, flushPendingScrollToMessage])

  const applyDefaultScrollPosition = React.useCallback(() => {
    if (
      !defaultScrollPosition ||
      defaultScrollPositionAppliedRef.current ||
      itemCountRef.current === 0
    ) {
      return false
    }

    let handled = false

    if (defaultScrollPosition === "last-anchor") {
      const content = contentRef.current
      const viewport = viewportRef.current
      const anchor =
        content && viewport
          ? getLastScrollAnchor(
              getMessageScrollerItems(content, spacerRef.current)
            )
          : null

      if (!content || !viewport || !anchor) {
        handled = scrollToEnd({ behavior: "auto" })
      } else {
        const anchorTop = getElementTop(anchor, viewport)
        const contentBottom = getContentBottom({
          content,
          spacer: spacerRef.current,
          viewport,
        })
        // A short last turn already fits below the anchor, so opening at the end
        // shows the whole turn without leaving a blank gap beneath it.
        const lastTurnFits = contentBottom - anchorTop <= viewport.clientHeight

        handled = lastTurnFits
          ? scrollToEnd({ behavior: "auto" })
          : scrollToElement(
              anchor,
              { align: "start" },
              { keepPreviousPeek: true }
            )
      }
    } else {
      handled =
        defaultScrollPosition === "end"
          ? scrollToEnd({ behavior: "auto" })
          : scrollToStart({ behavior: "auto" })
    }

    if (!handled) {
      return false
    }

    markDefaultScrollPositionApplied(refs)

    return true
  }, [defaultScrollPosition, scrollToElement, scrollToEnd, scrollToStart])

  const handleContentChange = React.useCallback(() => {
    const content = contentRef.current

    if (!content) {
      return
    }

    const items = getMessageScrollerItems(content, spacerRef.current)
    const previousItemCount = itemCountRef.current
    const previousFirstItem = firstItemRef.current

    itemCountRef.current = items.length
    firstItemRef.current = items[0] ?? null

    // Reconcile the scroll position with the new content. Every path re-captures
    // the prepend anchor afterward, so each branch just returns.
    //
    // Branch order is load-bearing: first-content, prepended, appended, updated.
    const reconcileScrollPosition = () => {
      if (flushPendingScrollToMessage()) {
        return
      }

      if (previousItemCount === 0) {
        if (applyDefaultScrollPosition()) {
          return
        }

        if (
          items.length > 0 &&
          autoScrollRef.current &&
          scrollToEnd({ behavior: "auto" })
        ) {
          return
        }

        commitScrollState()
        scheduleVisibilitySync()
        return
      }

      const previousFirstItemIndex = previousFirstItem
        ? items.indexOf(previousFirstItem)
        : -1
      const didPrepend =
        preserveScrollOnPrependRef.current && previousFirstItemIndex > 0

      // [operon] A reader keeps their row through any change of rows.
      const reading = isReading()
      if (reading) {
        restoreReadingAnchor()
      }

      if (didPrepend) {
        // Prepended rows are not new appends. Restore the prior scroll position.
        // The restore is a no-op where native scroll anchoring already did it.
        if (!reading) {
          restorePrependedAnchor()
        }
        return
      }

      if (items.length > previousItemCount) {
        const anchor = getNewScrollAnchor(items, previousItemCount)

        if (anchor) {
          // While the reader is following the live end, a batch of several
          // anchored turns arriving at once should keep following the end — not
          // yank back to anchor the first turn of the batch. A single new anchor
          // still moves to the top as usual.
          if (
            autoScrollRef.current &&
            modeRef.current === "following-bottom" &&
            hasMultipleNewScrollAnchors(items, previousItemCount)
          ) {
            scrollToEnd({ behavior: "auto" })
            return
          }

          scrollToElement(
            anchor,
            { align: "start" },
            { keepPreviousPeek: true }
          )
          handledScrollAnchorsRef.current.add(anchor)
          return
        }
      }

      if (items.length === previousItemCount) {
        const anchor = getUnanchoredScrollAnchor(
          items,
          handledScrollAnchorsRef.current
        )

        if (anchor) {
          scrollToElement(
            anchor,
            { align: "start" },
            { keepPreviousPeek: true }
          )
          handledScrollAnchorsRef.current.add(anchor)
          return
        }
      }

      // Appends with no new anchor (and content-only updates) fall through here:
      // keep following the end if we still are, otherwise just recommit state.
      if (modeRef.current === "following-bottom" && autoScrollRef.current) {
        scrollToEnd({ behavior: "auto" })
      } else {
        commitScrollState()
        scheduleVisibilitySync()
      }
    }

    reconcileScrollPosition()
    capturePrependAnchor()
    captureReadingAnchor()
  }, [
    applyDefaultScrollPosition,
    capturePrependAnchor,
    captureReadingAnchor,
    isReading,
    restoreReadingAnchor,
    commitScrollState,
    flushPendingScrollToMessage,
    restorePrependedAnchor,
    scheduleVisibilitySync,
    scrollToElement,
    scrollToEnd,
  ])

  const clearFinishedTurnSpacer = React.useCallback(() => {
    const viewport = viewportRef.current
    const spacerHeight = spacerHeightRef.current
    if (
      !turnActiveRef.current &&
      modeRef.current === "free-scrolling" &&
      streamingTurnRef.current &&
      spacerHeight > 0 &&
      viewport &&
      (viewport.scrollTop <= 0 ||
        getMaxScrollTop(viewport) - viewport.scrollTop >= spacerHeight)
    ) {
      // The reader is back within the real transcript's scroll range. Dropping
      // the spacer here preserves scrollTop and prevents returning to blank space.
      setTailSpacerHeight(0)
    }
  }, [setTailSpacerHeight])

  const viewportHeightRef = React.useRef(0)

  const handleResize = React.useCallback(() => {
    const resizedViewport = viewportRef.current
    const previousViewportHeight = viewportHeightRef.current
    viewportHeightRef.current = resizedViewport?.clientHeight ?? 0

    // [operon] A reader sitting at the live end stays there when the viewport
    // shrinks (a keyboard opening), even if following was never re-armed after
    // they scrolled back: keeping their first row would put the end out of view.
    if (
      resizedViewport &&
      autoScrollRef.current &&
      modeRef.current === "free-scrolling" &&
      spacerHeightRef.current === 0 &&
      resizedViewport.clientHeight < previousViewportHeight &&
      resizedViewport.scrollTop >=
        resizedViewport.scrollHeight -
          previousViewportHeight -
          scrollEdgeThresholdRef.current
    ) {
      scrollToEnd({ behavior: "auto" })
      return
    }

    if (modeRef.current === "following-bottom" && autoScrollRef.current) {
      scrollToEnd({ behavior: "auto" })
      return
    }

    // Hold the anchored turn in place as content below it resizes (a reply
    // streaming in, or a transient marker collapsing) — otherwise the shrinking
    // content lets the browser clamp scrollTop and the turn drops.
    const previousSpacerHeight = spacerHeightRef.current

    if (reanchorToAnchoredMessage()) {
      // The reply streaming below the anchor consumes the tail spacer as it
      // grows. Once the last of it is gone the reply has filled the viewport
      // and the reader is genuinely at the live edge, so autoScroll hands off
      // from the anchor hold to following the bottom. Requiring the >0 → 0
      // transition keeps a turn taller than the viewport (placed with no
      // spacer) held instead of yanked to the end.
      if (
        autoScrollRef.current &&
        previousSpacerHeight > 0 &&
        spacerHeightRef.current === 0
      ) {
        scrollToEnd({ behavior: "auto" })
      }

      return
    }

    // [operon] A settling jump keeps its row in place the same way.
    if (holdJumpTarget()) {
      return
    }

    // [operon] And a free reader keeps the row they are reading.
    restoreReadingAnchor()

    // [operon] Let reply growth consume a released turn's spacer using its
    // original reading line. Basing the height on the reader's scroll instead
    // shrinks the scroll range under them and can clamp their position.
    const turn = streamingTurnRef.current
    const viewport = viewportRef.current
    const content = contentRef.current
    const spacer = spacerRef.current
    if (
      turnActiveRef.current &&
      modeRef.current === "free-scrolling" &&
      previousSpacerHeight > 0 &&
      turn && viewport && content?.contains(turn)
    ) {
      const anchorTop = getElementScrollTop({
        align: "start",
        element: turn,
        scrollMargin: scrollMarginRef.current + scrollPreviousItemPeekRef.current,
        spacer,
        viewport,
      })
      setTailSpacerHeight(getTailSpacerHeight({
        content,
        scrollTop: Math.max(anchorTop, viewport.scrollTop),
        spacer,
        viewport,
      }))
    }

    clearFinishedTurnSpacer()
    scheduleStateCommit()
    scheduleVisibilitySync()
  }, [
    clearFinishedTurnSpacer,
    holdJumpTarget,
    reanchorToAnchoredMessage,
    restoreReadingAnchor,
    scheduleStateCommit,
    scheduleVisibilitySync,
    scrollToEnd,
    setTailSpacerHeight,
  ])

  const observeVisibility = React.useCallback(() => {
    const viewport = viewportRef.current

    if (!viewport || !visibilityStore.hasListeners()) {
      return
    }

    if (typeof IntersectionObserver === "undefined") {
      scheduleVisibilitySync()
      return
    }

    if (!visibilityObserverRef.current) {
      visibilityObserverRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const messageId = (entry.target as HTMLElement).dataset.messageId

            if (!messageId) {
              continue
            }

            if (entry.isIntersecting) {
              visibleMessageIdsRef.current.add(messageId)
            } else {
              visibleMessageIdsRef.current.delete(messageId)
            }
          }

          scheduleVisibilitySync()
        },
        {
          root: viewport,
          // Shrink the root's top edge to the anchoring line so a previous turn
          // peeking in the scrollMargin + peek band is not reported as visible,
          // keeping visibleMessageIds consistent with currentAnchorId. Captured
          // at observe time; a prop change rebuilds the observer on resubscribe.
          rootMargin: `${-(
            scrollMarginRef.current + scrollPreviousItemPeekRef.current
          )}px 0px 0px 0px`,
          threshold: [0, 0.01, 0.5, 1],
        }
      )
    }

    messageElementsRef.current.forEach((element) => {
      visibilityObserverRef.current?.observe(element)
    })
    scheduleVisibilitySync()
  }, [scheduleVisibilitySync, visibilityStore])

  const unobserveVisibility = React.useCallback(() => {
    if (visibilityFrameRef.current !== null) {
      window.cancelAnimationFrame(visibilityFrameRef.current)
      visibilityFrameRef.current = null
    }

    visibilityObserverRef.current?.disconnect()
    visibilityObserverRef.current = null
    visibleMessageIdsRef.current.clear()
    visibilityStore.setSnapshot(EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE)
  }, [visibilityStore])

  const registerMessage = React.useCallback<MessageScrollerRegisterMessage>(
    (messageId, element, removedElement) => {
      if (element) {
        messageElementsRef.current.set(messageId, element)
        visibilityObserverRef.current?.observe(element)
        scheduleVisibilitySync()

        if (pendingScrollToMessageRef.current?.messageId === messageId) {
          schedulePendingScrollToMessageFlush()
        }

        return
      }

      if (
        removedElement &&
        messageElementsRef.current.get(messageId) === removedElement
      ) {
        messageElementsRef.current.delete(messageId)
        visibleMessageIdsRef.current.delete(messageId)
        visibilityObserverRef.current?.unobserve(removedElement)
        scheduleVisibilitySync()
      }
    },
    [schedulePendingScrollToMessageFlush, scheduleVisibilitySync]
  )

  // [operon] `direction` is where the gesture would move this viewport: -1
  // toward the start, 1 toward the end, 0 nowhere (a sideways pan, a wheel a
  // nested scroller consumes, a key typed into a field), undefined unknown.
  const userScrollIntent = React.useCallback((direction?: number) => {
    const mode = modeRef.current

    // The reader's gesture takes over from any smooth scroll in flight.
    if (direction !== 0) {
      smoothScrollRef.current = false
    }
    if (direction === -1) {
      pendingFollowOnScrollEndRef.current = false
    }

    if (
      mode !== "following-bottom" &&
      mode !== "anchored-to-message" &&
      mode !== "settling-jump"
    ) {
      return
    }

    // A gesture that cannot move the viewport fires no scroll event, so nothing
    // would ever reconcile a release: the reader would sit at the end, no
    // longer followed, until they clicked the button.
    if (direction === 0) {
      return
    }



    // Following keeps the viewport at its max scrollTop, so pushing toward the
    // end (trailing trackpad momentum, End, PageDown) moves nothing either.
    // Anchored and settling still release: there the spacer leaves room below.
    if (mode === "following-bottom" && direction !== undefined && direction > 0) {
      return
    }

    // A deliberate gesture releases auto-follow, turn-anchoring, and an in-flight
    // programmatic jump so re-pinning (and re-arming) never fights the reader.
    // Keep the released turn as a geometry reference for its remaining spacer.
    modeRef.current = "free-scrolling"
    userReleasedFollowRef.current = true
  }, [])

  // [operon] Leave following as a reader's gesture would, without moving the
  // viewport (e.g. before a disclosure the reader opened grows the content).
  // Following resumes when the reader settles at the live end, or on a scroll
  // command.
  const stopFollowing = React.useCallback(() => {
    if (modeRef.current !== "following-bottom") {
      return
    }

    modeRef.current = "free-scrolling"
    userReleasedFollowRef.current = true
    captureReadingAnchor()
  }, [captureReadingAnchor])

  const mirrorStateAttributes = React.useCallback(
    () => writeStateAttributes(stateStore.getSnapshot()),
    [stateStore, writeStateAttributes]
  )

  const setRootElement = useElementRef(rootRef, mirrorStateAttributes)
  const setViewportElement = useElementRef(viewportRef, mirrorStateAttributes)

  const setContentElement = React.useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element
    },
    []
  )

  const setSpacerElement = React.useCallback(
    (element: HTMLDivElement | null) => {
      spacerRef.current = element
      spacerGapRef.current = getFlexGap(element?.parentElement ?? null)
    },
    []
  )

  const syncAfterScroll = React.useCallback(() => {
    // [operon] A layout shift that landed with this scroll is not the reader's.
    restoreReadingAnchor()

    const viewport = viewportRef.current
    if (viewport && userReleasedFollowRef.current) {
      const delta = viewport.scrollTop - lastScrollTopRef.current
      if (Math.abs(delta) > SCROLL_POSITION_EPSILON) {
        const maxScrollTop = getMaxScrollTop(viewport)
        // iOS reports its rubber-band overshoot, so a scroll that reached the
        // end finishes by moving up from past the maximum.
        const movedToEnd = delta > 0 || lastScrollTopRef.current > maxScrollTop
        // Reaching the edge is provisional while a gesture is still moving.
        pendingFollowOnScrollEndRef.current =
          movedToEnd && spacerHeightRef.current === 0 &&
          viewport.scrollTop >= maxScrollTop - scrollEdgeThresholdRef.current
      }
    }
    commitScrollState()
    clearFinishedTurnSpacer()
    lastScrollTopRef.current = viewport?.scrollTop ?? 0
    scheduleVisibilitySync()
    capturePrependAnchor()
    captureReadingAnchor()
  }, [
    capturePrependAnchor,
    captureReadingAnchor,
    clearFinishedTurnSpacer,
    commitScrollState,
    restoreReadingAnchor,
    scheduleVisibilitySync,
  ])

  const handleScrollEnd = React.useCallback(() => {
    if (smoothScrollRef.current) {
      smoothScrollRef.current = false
      captureReadingAnchor()
    }

    const pendingFollow = pendingFollowOnScrollEndRef.current
    pendingFollowOnScrollEndRef.current = false
    const viewport = viewportRef.current
    if (
      pendingFollow &&
      viewport &&
      userReleasedFollowRef.current &&
      modeRef.current === "free-scrolling" &&
      spacerHeightRef.current === 0 &&
      viewport.scrollTop >= getMaxScrollTop(viewport) - scrollEdgeThresholdRef.current
    ) {
      userReleasedFollowRef.current = false
      commitScrollState()
    }
  }, [captureReadingAnchor, commitScrollState])

  const context = React.useMemo<MessageScrollerContextValue>(
    () => ({
      handleContentChange,
      handleResize,
      observeVisibility,
      pendingDefaultScrollStore,
      preserveScrollOnPrependRef,
      scrollToEnd,
      scrollToMessage,
      scrollToStart,
      stopFollowing,
      setContentElement,
      setRootElement,
      setSpacerElement,
      setViewportElement,
      stateStore,
      syncAfterScroll,
      handleScrollEnd,
      unobserveVisibility,
      userScrollIntent,
      viewportRef,
      visibilityStore,
    }),
    [
      handleContentChange,
      handleResize,
      observeVisibility,
      pendingDefaultScrollStore,
      scrollToEnd,
      scrollToMessage,
      scrollToStart,
      stopFollowing,
      setContentElement,
      setRootElement,
      setSpacerElement,
      setViewportElement,
      stateStore,
      syncAfterScroll,
      handleScrollEnd,
      unobserveVisibility,
      userScrollIntent,
      visibilityStore,
    ]
  )

  React.useLayoutEffect(() => {
    if (applyDefaultScrollPosition()) {
      return
    }

    if (itemCountRef.current === 0) {
      clearPendingDefaultScroll(refs)
    }
  }, [applyDefaultScrollPosition])

  React.useEffect(() => {
    return () => {
      // Reset every ref after cancelling. StrictMode replays effects on the same
      // refs (unmount then remount), so a frame id left non-null here makes the
      // scheduler on remount think a frame is still pending and never reschedule.
      if (stateFrameRef.current !== null) {
        window.cancelAnimationFrame(stateFrameRef.current)
        stateFrameRef.current = null
      }

      if (visibilityFrameRef.current !== null) {
        window.cancelAnimationFrame(visibilityFrameRef.current)
        visibilityFrameRef.current = null
      }

      if (autoscrollingTimeoutRef.current !== null) {
        window.clearTimeout(autoscrollingTimeoutRef.current)
        autoscrollingTimeoutRef.current = null
      }

      if (pendingScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingScrollFrameRef.current)
        pendingScrollFrameRef.current = null
      }

      visibilityObserverRef.current?.disconnect()
      visibilityObserverRef.current = null
    }
  }, [])

  React.useLayoutEffect(() => {
    if (
      autoScroll &&
      modeRef.current === "following-bottom" &&
      itemCountRef.current > 0
    ) {
      scrollToEnd({ behavior: "auto" })
      return
    }

    clearFinishedTurnSpacer()
    commitScrollState()
  }, [autoScroll, turnActive, clearFinishedTurnSpacer, commitScrollState, scrollToEnd])

  return {
    context,
    registerMessage,
  }
}

export { useMessageScrollerController }
