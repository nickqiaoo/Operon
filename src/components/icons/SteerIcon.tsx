import type { SVGProps } from "react"
import { cn } from "@/lib/utils"

/**
 * Steer a running turn: an arrow that changes lanes on its way up — the agent
 * keeps going, just in a new direction. Drawn on lucide's 24px grid with the
 * same stroke conventions so it drops in for any lucide icon.
 */
export function SteerIcon({ className, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-6", className)}
      aria-hidden="true"
      {...props}
    >
      <path d="M7 21v-3a4 4 0 0 1 4-4h2a4 4 0 0 0 4-4V4" />
      <path d="M13 8l4-4 4 4" />
    </svg>
  )
}
