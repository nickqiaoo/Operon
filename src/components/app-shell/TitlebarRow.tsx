import { createContext, useContext, type ComponentProps } from "react"
import { motion, useTransform, type MotionValue } from "motion/react"

export const TitlebarClearanceContext = createContext<MotionValue<number> | null>(null)

interface TitlebarRowProps extends ComponentProps<typeof motion.div> {
  clearSidebarToggle?: boolean
  defaultPadding?: string
}

export function TitlebarRow({
  clearSidebarToggle = true,
  defaultPadding = "1rem",
  style,
  ...props
}: TitlebarRowProps) {
  const clearance = useContext(TitlebarClearanceContext)
  const paddingLeft = useTransform(() => {
    const extra = clearSidebarToggle ? clearance?.get() ?? 0 : 0
    return extra > 0 ? `max(${defaultPadding}, ${extra}px)` : defaultPadding
  })

  return <motion.div {...props} style={clearSidebarToggle ? { ...style, paddingLeft } : style} />
}
