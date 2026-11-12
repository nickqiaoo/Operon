import type { SVGProps } from "react"
import { cn } from "@/lib/utils"

/**
 * The sidebar's Active list: a conversation in front of another, with the
 * typing dots of one still going — "the chats in play", as opposed to the
 * Assistant's single round bubble. Drawn on lucide's 24px grid with the same
 * stroke conventions so it drops in for any lucide icon.
 */
export function ActiveChatsIcon({ className, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement>) {
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
      <path d="M3 9.5A2.5 2.5 0 0 1 5.5 7h9A2.5 2.5 0 0 1 17 9.5v6a2.5 2.5 0 0 1-2.5 2.5H8l-5 3.5z" />
      <path d="M7 3.5h11.5A2.5 2.5 0 0 1 21 6v8" />
      <path d="M7.5 12.5h.01M10 12.5h.01M12.5 12.5h.01" />
    </svg>
  )
}
