import type { ReactNode, Ref } from "react"
import { createPortal } from "react-dom"
import { useIntl } from "react-intl"
import { AnimatePresence, motion, useDragControls, type PanInfo } from "motion/react"
import { cn } from "@/lib/utils"

interface MobileSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  sheetClassName?: string
  bodyClassName?: string
  contentRef?: Ref<HTMLDivElement>
}

/**
 * Minimal bottom sheet — the project lacks a `ui/sheet` primitive and full
 * dialogs/popovers are positioned for a mouse. Slides up from the bottom with a
 * dimmed backdrop; tapping the backdrop closes it, as does dragging the grab
 * handle down past a threshold (or flicking it). The drag is bound to the handle
 * (via {@link useDragControls}) so the scrollable body still scrolls normally.
 * Portals to body so it sits above the tab bar and any screen content.
 */
export function MobileSheet({ open, onClose, title, children, sheetClassName, bodyClassName, contentRef }: MobileSheetProps) {
  const intl = useIntl()
  const dragControls = useDragControls()

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    // Dismiss when dragged far enough down, or flicked down quickly.
    if (info.offset.y > 120 || info.velocity.y > 600) {
      onClose()
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end overflow-hidden">
          <motion.button
            type="button"
            aria-label={intl.formatMessage({ id: "mobile.sheet.close", defaultMessage: "Close" })}
            onClick={onClose}
            className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.div
            ref={contentRef}
            data-slot="mobile-sheet-content"
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "relative box-border max-h-[80vh] w-full min-w-0 max-w-[100vw] self-center overflow-hidden rounded-t-2xl border-t border-border/50 bg-background shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.4)]",
              sheetClassName
            )}
            // A sheet with an input in it (e.g. "New channel") opens the keyboard
            // right away; pad past it so the field stays visible. The keyboard
            // covers the home-indicator strip, so the insets don't stack.
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), var(--keyboard-height))" }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 34, stiffness: 340 }}
            drag="y"
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={handleDragEnd}
          >
            <div
              onPointerDown={(event) => dragControls.start(event)}
              className="flex cursor-grab touch-none flex-col items-center pt-2.5 active:cursor-grabbing"
            >
              <div className="h-1 w-9 rounded-full bg-muted-foreground/25" />
              {title && (
                <div className="w-full px-5 pb-2 pt-3">
                  <h2 className="text-sm font-semibold text-foreground/90">{title}</h2>
                </div>
              )}
            </div>
            <div
              data-slot="mobile-sheet-body"
              className={cn(
                "max-h-[70vh] min-w-0 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain px-3 pb-3 [-webkit-overflow-scrolling:touch]",
                bodyClassName
              )}
            >
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  )
}
