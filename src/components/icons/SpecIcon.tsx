import type { SVGProps } from "react"
import { cn } from "@/lib/utils"

/**
 * OperonSpec: a design sheet with a set square in the corner — "a drawn-up
 * plan", as opposed to a plain document or a git branch. Drawn on lucide's
 * 24px grid with the same stroke conventions so it drops in for any lucide icon.
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
      <path d="M10 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4" />
      <path d="M9 7.5h6" />
      <path d="M9 11.5h3" />
      <path d="M14 13.5v7.5h7.5z" />
    </svg>
  )
}
