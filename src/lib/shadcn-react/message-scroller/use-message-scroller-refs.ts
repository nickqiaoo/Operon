import * as React from "react"

import {
  areScrollStatesEqual,
  createMessageScrollerStore,
  createMessageScrollerVisibilityStore,
} from "./stores"
import { EMPTY_MESSAGE_SCROLLER_SCROLLABLE } from "./types"
import type {
  MessageScrollerDefaultScrollPosition,
  MessageScrollerMode,
  MessageScrollerScrollable,
  MessageScrollerScrollOptions,
  MessageScrollerStore,
  MessageScrollerVisibilityStore,
} from "./types"

// Shared mutable ref bag for one MessageScroller, closed over by both the
// controller and the commands so writes are visible across them without prop
// threading. stateStore and visibilityStore fan out via useSyncExternalStore.
type MessageScrollerRefs = {
  autoScrollRef: React.RefObject<boolean>
  autoscrollingRef: React.RefObject<boolean>
  autoscrollingTimeoutRef: React.RefObject<number | null>
  streamingTurnRef: React.RefObject<HTMLElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  defaultScrollPositionAppliedRef: React.RefObject<boolean>
  firstItemRef: React.RefObject<HTMLElement | null>
  itemCountRef: React.RefObject<number>
  jumpTargetRef: React.RefObject<{
    element: HTMLElement
    viewportTop: number
  } | null>
  lastScrollTopRef: React.RefObject<number>
  messageElementsRef: React.RefObject<Map<string, HTMLElement>>
  modeRef: React.RefObject<MessageScrollerMode>
  pendingFollowOnScrollEndRef: React.RefObject<boolean>
  pendingScrollFrameRef: React.RefObject<number | null>
  pendingScrollToMessageRef: React.RefObject<{
    messageId: string
    options?: MessageScrollerScrollOptions
  } | null>
  prependRestoreRef: React.RefObject<{
    element: HTMLElement
    viewportTop: number
  } | null>
  readingAnchorRef: React.RefObject<{
    element: HTMLElement
    top: number
  } | null>
  smoothScrollRef: React.RefObject<boolean>
  preserveScrollOnPrependRef: React.RefObject<boolean>
  pendingDefaultScrollStore: MessageScrollerStore<boolean>
  rootRef: React.RefObject<HTMLDivElement | null>
  scrollEdgeThresholdRef: React.RefObject<number>
  scrollMarginRef: React.RefObject<number>
  scrollPreviousItemPeekRef: React.RefObject<number>
  spacerGapRef: React.RefObject<number>
  spacerHeightRef: React.RefObject<number>
  spacerRef: React.RefObject<HTMLDivElement | null>
  stateFrameRef: React.RefObject<number | null>
  stateStore: MessageScrollerStore<MessageScrollerScrollable>
  userReleasedFollowRef: React.RefObject<boolean>
  viewportRef: React.RefObject<HTMLDivElement | null>
  visibilityFrameRef: React.RefObject<number | null>
  visibilityObserverRef: React.RefObject<IntersectionObserver | null>
  visibilityStore: MessageScrollerVisibilityStore
  visibleMessageIdsRef: React.RefObject<Set<string>>
  handledScrollAnchorsRef: React.RefObject<WeakSet<HTMLElement>>
}

// Builds the per-instance ref bag: the two external stores constructed once, and
// the latest prop values mirrored onto refs each render so callbacks stay stable.
function useMessageScrollerRefs({
  autoScroll,
  defaultScrollPosition,
  scrollEdgeThreshold,
  scrollMargin,
  scrollPreviousItemPeek,
}: {
  autoScroll: boolean
  defaultScrollPosition: MessageScrollerDefaultScrollPosition
  scrollEdgeThreshold: number
  scrollMargin: number
  scrollPreviousItemPeek: number
}): MessageScrollerRefs {
  const autoScrollRef = React.useRef(autoScroll)
  const autoscrollingRef = React.useRef(false)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const defaultScrollPositionAppliedRef = React.useRef(false)
  const scrollEdgeThresholdRef = React.useRef(scrollEdgeThreshold)
  const itemCountRef = React.useRef(0)
  const firstItemRef = React.useRef<HTMLElement | null>(null)
  // The last handled scroll position, including programmatic placements and
  // layout corrections. Measuring scrollability must not advance this baseline.
  const lastScrollTopRef = React.useRef(0)
  // [operon] The row an instant jump placed, and where in the viewport it
  // landed. While the jump is settling, resizes keep it there (rows around it
  // often settle from estimated heights a few frames later, e.g. under
  // content-visibility, and insets measured after mount move every row).
  const jumpTargetRef = React.useRef<{
    element: HTMLElement
    viewportTop: number
  } | null>(null)
  const modeRef = React.useRef<MessageScrollerMode>(
    autoScroll ? "following-bottom" : "free-scrolling"
  )
  const pendingFollowOnScrollEndRef = React.useRef(false)
  const messageElementsRef = React.useRef(new Map<string, HTMLElement>())
  const pendingScrollToMessageRef = React.useRef<{
    messageId: string
    options?: MessageScrollerScrollOptions
  } | null>(null)
  // The row to hold steady on the next prepend: the first visible row, or a jump
  // target seeded by scrollToElement. restorePrependedAnchor reads only this.
  const prependRestoreRef = React.useRef<{
    element: HTMLElement
    viewportTop: number
  } | null>(null)
  // [operon] The row a free reader is looking at, by its offset in the content
  // (not the viewport: content coordinates exclude the reader's own scrolling
  // since the snapshot, which a viewport offset would undo).
  const readingAnchorRef = React.useRef<{
    element: HTMLElement
    top: number
  } | null>(null)
  // [operon] A smooth programmatic scroll is animating; compensating under it
  // would cancel the animation.
  const smoothScrollRef = React.useRef(false)
  // The turn held at the reading line so a reply streaming in below it can re-pin
  // it instead of letting scrollTop clamp it loose.
  const streamingTurnRef = React.useRef<HTMLElement | null>(null)
  const scrollPreviousItemPeekRef = React.useRef(scrollPreviousItemPeek)
  const preserveScrollOnPrependRef = React.useRef(true)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const scrollMarginRef = React.useRef(scrollMargin)
  const pendingScrollFrameRef = React.useRef<number | null>(null)
  const spacerGapRef = React.useRef(0)
  const spacerHeightRef = React.useRef(0)
  const spacerRef = React.useRef<HTMLDivElement | null>(null)
  const stateFrameRef = React.useRef<number | null>(null)
  const pendingDefaultScrollStoreRef =
    React.useRef<MessageScrollerStore<boolean> | null>(null)
  const stateStoreRef =
    React.useRef<MessageScrollerStore<MessageScrollerScrollable> | null>(null)
  const autoscrollingTimeoutRef = React.useRef<number | null>(null)
  // [operon] Set when a reader's gesture releases follow-bottom. Until the reader
  // scrolls back to the end themselves (or a scroll command runs), a commit that
  // merely measures "at the end" must not re-arm following: the gesture's own
  // scroll can land a frame later, and re-arming in between lets the next
  // resize pull the reader back down.
  const userReleasedFollowRef = React.useRef(false)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const visibilityFrameRef = React.useRef<number | null>(null)
  const visibilityObserverRef = React.useRef<IntersectionObserver | null>(null)
  const visibilityStoreRef =
    React.useRef<MessageScrollerVisibilityStore | null>(null)
  const visibleMessageIdsRef = React.useRef(new Set<string>())
  const handledScrollAnchorsRef = React.useRef(new WeakSet<HTMLElement>())

  if (pendingDefaultScrollStoreRef.current === null) {
    pendingDefaultScrollStoreRef.current = createMessageScrollerStore(
      defaultScrollPosition === "end" ||
        defaultScrollPosition === "last-anchor",
      (current, next) => current === next
    )
  }

  if (stateStoreRef.current === null) {
    stateStoreRef.current = createMessageScrollerStore(
      EMPTY_MESSAGE_SCROLLER_SCROLLABLE,
      areScrollStatesEqual
    )
  }

  if (visibilityStoreRef.current === null) {
    visibilityStoreRef.current = createMessageScrollerVisibilityStore()
  }

  // Track the latest prop values on every render so callbacks read fresh values
  // without being recreated (the useLatest pattern).
  autoScrollRef.current = autoScroll
  scrollEdgeThresholdRef.current = scrollEdgeThreshold
  scrollMarginRef.current = scrollMargin
  scrollPreviousItemPeekRef.current = scrollPreviousItemPeek

  return {
    autoScrollRef,
    autoscrollingRef,
    autoscrollingTimeoutRef,
    streamingTurnRef,
    contentRef,
    defaultScrollPositionAppliedRef,
    firstItemRef,
    itemCountRef,
    jumpTargetRef,
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
    pendingDefaultScrollStore: pendingDefaultScrollStoreRef.current,
    rootRef,
    scrollEdgeThresholdRef,
    scrollMarginRef,
    scrollPreviousItemPeekRef,
    spacerGapRef,
    spacerHeightRef,
    spacerRef,
    stateFrameRef,
    stateStore: stateStoreRef.current,
    userReleasedFollowRef,
    viewportRef,
    visibilityFrameRef,
    visibilityObserverRef,
    visibilityStore: visibilityStoreRef.current,
    visibleMessageIdsRef,
    handledScrollAnchorsRef,
  }
}

function clearPendingDefaultScroll(refs: MessageScrollerRefs) {
  refs.pendingDefaultScrollStore.setSnapshot(false)
}

function markDefaultScrollPositionApplied(refs: MessageScrollerRefs) {
  refs.defaultScrollPositionAppliedRef.current = true
  clearPendingDefaultScroll(refs)
}

export {
  clearPendingDefaultScroll,
  markDefaultScrollPositionApplied,
  useMessageScrollerRefs,
}
export type { MessageScrollerRefs }
