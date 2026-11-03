# Forked from `@shadcn/react`

`message-scroller/` and `use-render/` are copied from
[shadcn-ui/ui](https://github.com/shadcn-ui/ui) `packages/react/src/` (MIT) and
maintained here. The rest of `@shadcn/react` (e.g. `questionnaire`) is still
used from npm.

- **Base:** `4aaea19d9cff3e0908e12a8c1d504b8c5ec34610` (2026-11-02,
  "drain released tail spacer after manual scroll during anchored stream").
  Newer than the last npm release, 0.3.1 (2026-08-31).
- **Why forked:** the chat transcript kept a second follow state in
  `src/components/ai-elements/conversation.tsx` to work around library bugs, and
  the two drifted apart a frame at a time. Fixes for most of those bugs sat in
  unreviewed upstream PRs for months. We fix them here, against our own tests,
  and do not track upstream PRs.

Our changes are marked `[operon]` in the source. Diff a file against the base
with:

```sh
gh api "repos/shadcn-ui/ui/contents/packages/react/src/message-scroller/<file>?ref=4aaea19d9cff3e0908e12a8c1d504b8c5ec34610" --jq .content | base64 -d | diff - src/lib/shadcn-react/message-scroller/<file>
```

## Changes

1. **Resize handled before paint.** The viewport and content ResizeObservers call
   `handleResize` during delivery instead of on the next frame (follow gap and
   anchored scroll-height wobble painted once per streamed chunk). When handling
   resizes the observed content itself (tail spacer writes), observation is
   suspended and resumed next frame, so no "ResizeObserver loop" error. Content
   is observed as border-box, so padding changes are seen. (`components.tsx`)
2. **Only gestures that can move the viewport release follow/anchor.** A sideways
   wheel or swipe, a wheel or swipe a nested scroller takes, one toward an edge
   the viewport already sits at (including an anchored turn's spacer holding it
   at max scrollTop), scroll keys typed into a field, and Space on a control are
   ignored; they fired no scroll event, so nothing ever re-armed. Touch direction
   comes from `touchstart`/`touchmove`. (`getGestureDirection` in
   `components.tsx`, `userScrollIntent` in the controller)
3. **A reader's release sticks until they come back.** After a gesture releases
   following, a commit that merely measures the end (before the gesture's own
   scroll lands, or after one that moved nothing) does not re-arm it; a scroll
   that moves down onto the end, or any scroll command, does.
   (`userReleasedFollowRef`, `reconcileFollowMode`, `scrollToPosition`)
4. **`end` counts a released spacer.** Once the reader has left (free-scrolling),
   a short turn's reserved spacer they can scroll back into is reported as room
   below, so the scroll button shows and a prompt sent from there does not
   anchor-jump them. (`commitScrollState`)
5. **A settling jump holds its row.** After an instant `scrollToMessage`, resizes
   keep the target where in the viewport it landed (rows around it settling from
   estimated heights, an inset measured after mount), until a gesture or another
   scroll command. Smooth jumps are not held. (`jumpTargetRef`, `holdJumpTarget`)
6. **Reading position preserved for a free reader.** While nothing else holds
   the viewport (free-scrolling, or following paused by `autoScroll={false}`),
   the first visible row is kept in place by its *content* offset through any
   layout shift above it: older history mounting, rows settling from estimated
   heights (content-visibility), insets changing. Restored on resize, on row
   insertion/removal and on scroll; skipped while a smooth programmatic scroll
   animates (until `scrollend`). This replaces upstream's viewport-offset
   prepend restore while reading, so the viewport sets `overflow-anchor: none`
   (native anchoring would apply the same shift twice). Gated by the existing
   `preserveScrollOnPrepend` prop. (`captureReadingAnchor`,
   `restoreReadingAnchor`, `handleScrollEnd`)
7. **`stopFollowing()`** on `useMessageScroller()`: leave following as a gesture
   would, without moving the viewport.

Upstream test changed: `message-scroller.browser.test.tsx` "drains a released
spacer..." now releases with an upward wheel (a downward one at the anchored max
scrollTop no longer releases, per change 2).

## Tests

- `npx vitest run src/lib/shadcn-react` - upstream jsdom suites.
- `npm run test:browser` - upstream browser and perf suites, plus
  `operon.browser.test.tsx` for the changes above. Each targeted case there was
  checked to fail with its change reverted.
