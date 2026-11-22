import { motion, motionValue, useTransform } from "motion/react"

/**
 * The right panel's width as it animates, written by RightPanel. Headers read
 * it to know how much of the window's top-right corner the panel still covers.
 */
export const rightPanelAnimatedWidth = motionValue(0)

/**
 * Room a header leaves at its right end for the window-level panel controls
 * (TopBarControls), which stay pinned to the window edge. While the right panel
 * is out they sit over the panel, so the header only needs `open` px; as the
 * panel closes the reserve grows to `closed` px in step with it.
 *
 * Switching on `rightPanelOpen` instead reserved the full width the moment the
 * panel started closing, while the header was still as narrow as the open split
 * left it — the breadcrumbs truncated for a frame and snapped back.
 */
export function TopBarControlsReserve({ closed, open }: { closed: number; open: number }) {
  const width = useTransform(rightPanelAnimatedWidth, (panel) => Math.max(open, closed - panel))
  return <motion.div aria-hidden="true" className="shrink-0" style={{ width }} />
}
