import type { SVGProps } from "react"
import { cn } from "@/lib/utils"

/**
 * OperonSpec: a document with a sparkle in its open corner — "a design the
 * agents draft for you", as opposed to a plain document. The page's top-right
 * edge stops short so the sparkle sits in the gap instead of overlapping it.
 * Drawn on lucide's 24px grid with the same stroke conventions so it drops in
 * for any lucide icon.
 */
export function SpecIcon({ className, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement>) {
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
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7.5" />
      <path d="M18.5 2.5 19.4 4.6 21.5 5.5 19.4 6.4 18.5 8.5 17.6 6.4 15.5 5.5 17.6 4.6z" />
      <path d="M9 12h6" />
      <path d="M9 16h4" />
    </svg>
  )
}
