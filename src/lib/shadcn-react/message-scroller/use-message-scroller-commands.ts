import * as React from "react"

import {
  getElementScrollTop,
  getElementViewportTop,
  getMaxScrollTop,
  getTailSpacerHeight,
} from "./geometry"
import { AUTOSCROLLING_CLEAR_DELAY, SCROLL_POSITION_EPSILON } from "./types"
import type { MessageScrollerScrollOptions } from "./types"
import {
  markDefaultScrollPositionApplied,
  type MessageScrollerRefs,
} from "./use-message-scroller-refs"

// Imperative scroll primitives, split from the controller so the move mechanics
// live apart from the policy that decides when to run them. Each command resolves
// a target scrollTop and returns false when the viewport is not mounted yet.
function useMessageScrollerCommands({
  refs,
  commitScrollState,
  scheduleStateCommit,
  scheduleVisibilitySync,
}: {
  refs: MessageScrollerRefs
  commitScrollState: () => void
  scheduleStateCommit: () => void
  scheduleVisibilitySync: () => void
}) {
  const {
    streamingTurnRef,
    autoScrollRef,
    autoscrollingRef,
    autoscrollingTimeoutRef,
    contentRef,
    itemCountRef,
    jumpTargetRef,
    lastScrollTopRef,
    messageElementsRef,
    modeRef,
    pendingFollowOnScrollEndRef,
    pendingScrollToMessageRef,
    prependRestoreRef,
    scrollMarginRef,
    scrollPreviousItemPeekRef,
    spacerGapRef,
    spacerHeightRef,
    smoothScrollRef,
    spacerRef,
    userReleasedFollowRef,
    viewportRef,
  } = refs

  const setAutoScrolling = React.useCallback(
    (autoscrolling: boolean) => {
      if (autoscrollingTimeoutRef.current !== null) {
        window.clearTimeout(autoscrollingTimeoutRef.current)
        autoscrollingTimeoutRef.current = null
      }

      if (autoscrollingRef.current !== autoscrolling) {
        autoscrollingRef.current = autoscrolling
        commitScrollState()
      }

      if (autoscrolling) {
        autoscrollingTimeoutRef.current = window.setTimeout(() => {
          autoscrollingTimeoutRef.current = null
          autoscrollingRef.current = false
          commitScrollState()
        }, AUTOSCROLLING_CLEAR_DELAY)
      }
    },
    [commitScrollState]
  )

  // Low-level spacer primitive. Unlike the scroll commands, this does not move
  // the viewport: it only writes the tail spacer's reserved height (hiding it
  // at zero). It lives on the commands surface rather than staying private to
  // the controller because the controller both reserves room for an anchored
  // turn and consumes it as the reply grows after the reader has scrolled away.
  // Both paths need the same write. It
  // is intentionally not a user-facing scroll command - treat it as an internal
  // handle the orchestrator threads through to keep spacer writes in one place.
  const setTailSpacerHeight = React.useCallback((height: number) => {
    const spacer = spacerRef.current

    if (!spacer) {
      return
    }

    const nextHeight = Math.max(0, Math.ceil(height))

    if (spacerHeightRef.current === nextHeight) {
      return
    }

    spacerHeightRef.current = nextHeight
    spacer.hidden = nextHeight === 0
    spacer.style.height = `${nextHeight}px`
    spacer.style.marginTop = nextHeight > 0 ? `${-spacerGapRef.current}px` : ""
  }, [])

  const scrollToPosition = React.useCallback(
    (
      scrollTop: number,
      {
        behavior = "auto",
        autoscrolling = false,
      }: {
        behavior?: ScrollBehavior
        autoscrolling?: boolean
      } = {}
    ) => {
      const viewport = viewportRef.current

      if (!viewport) {
        return
      }

      // [operon] A scroll command is an explicit placement: it supersedes a
      // reader's earlier release, so following may re-arm from here on.
      userReleasedFollowRef.current = false
      pendingFollowOnScrollEndRef.current = false

      const nextScrollTop = Math.max(0, scrollTop)

      if (
        Math.abs(viewport.scrollTop - nextScrollTop) <= SCROLL_POSITION_EPSILON
      ) {
        viewport.scrollTop = nextScrollTop
        lastScrollTopRef.current = viewport.scrollTop
        commitScrollState()
        return
      }

      if (autoscrolling) {
        setAutoScrolling(true)
      }

      // [operon] Cleared on scrollend (or the reader's next gesture).
      smoothScrollRef.current = behavior === "smooth"

      viewport.scrollTo({
        top: nextScrollTop,
        behavior,
      })
      lastScrollTopRef.current = viewport.scrollTop
      scheduleStateCommit()
    },
    [commitScrollState, scheduleStateCommit, setAutoScrolling]
  )

  const scrollToStart = React.useCallback(
    ({ behavior = "auto" }: MessageScrollerScrollOptions = {}) => {
      if (!viewportRef.current) {
        return false
      }

      setTailSpacerHeight(0)
      streamingTurnRef.current = null
      jumpTargetRef.current = null
      modeRef.current = "free-scrolling"
      scrollToPosition(0, { behavior })
      scheduleVisibilitySync()

      return true
    },
    [scheduleVisibilitySync, scrollToPosition, setTailSpacerHeight]
  )

  const scrollToEnd = React.useCallback(
    ({ behavior = "auto" }: MessageScrollerScrollOptions = {}) => {
      const viewport = viewportRef.current

      if (!viewport) {
        return false
      }

      setTailSpacerHeight(0)
      streamingTurnRef.current = null
      jumpTargetRef.current = null
      modeRef.current = autoScrollRef.current
        ? "following-bottom"
        : "free-scrolling"
      scrollToPosition(getMaxScrollTop(viewport), {
        autoscrolling: true,
        behavior,
      })
      scheduleVisibilitySync()

      return true
    },
    [scheduleVisibilitySync, scrollToPosition, setTailSpacerHeight]
  )

  const scrollToElement = React.useCallback(
    (
      element: HTMLElement,
      {
        align = "start",
        behavior = "auto",
        scrollMargin = scrollMarginRef.current,
      }: MessageScrollerScrollOptions = {},
      {
        keepPreviousPeek = false,
      }: {
        keepPreviousPeek?: boolean
      } = {}
    ) => {
      const content = contentRef.current
      const viewport = viewportRef.current

      if (!content || !viewport || !content.contains(element)) {
        return false
      }

      const scrollTop = getElementScrollTop({
        align,
        element,
        scrollMargin: keepPreviousPeek
          ? scrollMargin + scrollPreviousItemPeekRef.current
          : scrollMargin,
        spacer: spacerRef.current,
        viewport,
      })

      const nextSpacerHeight = getTailSpacerHeight({
        content,
        scrollTop,
        spacer: spacerRef.current,
        viewport,
      })

      setTailSpacerHeight(nextSpacerHeight)
      // Seed the prepend anchor with the jump target so a prepend that lands
      // before this scroll settles still preserves the jumped-to row; once it
      // settles, syncAfterScroll's capturePrependAnchor re-captures it from the
      // first visible row.
      prependRestoreRef.current = {
        element,
        viewportTop: getElementViewportTop(element, viewport),
      }

      modeRef.current = keepPreviousPeek
        ? "anchored-to-message"
        : "settling-jump"
      streamingTurnRef.current = keepPreviousPeek ? element : null
      jumpTargetRef.current = null

      scrollToPosition(scrollTop, { behavior })
      scheduleVisibilitySync()

      // [operon] A smooth jump is left alone: holding it would fight its
      // animation. Anything else has landed by now.
      if (!keepPreviousPeek && behavior !== "smooth") {
        jumpTargetRef.current = {
          element,
          viewportTop: getElementViewportTop(element, viewport),
        }
      }

      return true
    },
    [scheduleVisibilitySync, scrollToPosition, setTailSpacerHeight]
  )

  const reanchorToAnchoredMessage = React.useCallback(() => {
    const element = streamingTurnRef.current

    if (
      !element ||
      !element.isConnected ||
      modeRef.current !== "anchored-to-message"
    ) {
      return false
    }

    // Re-run the placement so the tail spacer is recomputed for the new content
    // height and the turn is held at the reading line.
    return scrollToElement(
      element,
      { align: "start" },
      { keepPreviousPeek: true }
    )
  }, [scrollToElement])

  // [operon] Keep a settling jump's row where in the viewport the jump put it
  // as content resizes, the way an anchored turn is held. Returns true when it
  // had to move the viewport.
  const holdJumpTarget = React.useCallback(() => {
    const target = jumpTargetRef.current
    const content = contentRef.current
    const viewport = viewportRef.current

    if (
      !target ||
      !content ||
      !viewport ||
      !target.element.isConnected ||
      modeRef.current !== "settling-jump"
    ) {
      return false
    }

    const delta =
      getElementViewportTop(target.element, viewport) - target.viewportTop

    if (Math.abs(delta) <= SCROLL_POSITION_EPSILON) {
      return false
    }

    const scrollTop = viewport.scrollTop + delta

    // Room to scroll there, if the content below has shrunk.
    setTailSpacerHeight(
      getTailSpacerHeight({
        content,
        scrollTop,
        spacer: spacerRef.current,
        viewport,
      })
    )
    scrollToPosition(scrollTop, { behavior: "instant" })

    return true
  }, [scrollToPosition, setTailSpacerHeight])

  // The target row may not be mounted yet (e.g. an async-loaded transcript).
  // When it is missing the request is queued in pendingScrollToMessageRef and
  // flushed later — on registerMessage for that id, or on the next content
  // change. An explicit jump also marks the mount default as applied, so
  // defaultScrollPosition does not override it.
  const scrollToMessage = React.useCallback(
    (messageId: string, options?: MessageScrollerScrollOptions) => {
      const element = messageElementsRef.current.get(messageId)

      if (!element) {
        if (itemCountRef.current === 0) {
          pendingScrollToMessageRef.current = {
            messageId,
            options,
          }
          markDefaultScrollPositionApplied(refs)

          return true
        }

        return false
      }

      markDefaultScrollPositionApplied(refs)

      if (scrollToElement(element, options)) {
        pendingScrollToMessageRef.current = null
        return true
      }

      pendingScrollToMessageRef.current = {
        messageId,
        options,
      }

      return true
    },
    [scrollToElement]
  )

  const flushPendingScrollToMessage = React.useCallback(() => {
    const pending = pendingScrollToMessageRef.current

    if (!pending) {
      return false
    }

    const element = messageElementsRef.current.get(pending.messageId)

    if (!element) {
      return false
    }

    const handled = scrollToElement(element, pending.options)

    if (!handled) {
      return false
    }

    pendingScrollToMessageRef.current = null
    markDefaultScrollPositionApplied(refs)

    return true
  }, [scrollToElement])

  return {
    flushPendingScrollToMessage,
    holdJumpTarget,
    reanchorToAnchoredMessage,
    scrollToElement,
    scrollToEnd,
    scrollToMessage,
    scrollToStart,
    setTailSpacerHeight,
  }
}

export { useMessageScrollerCommands }
