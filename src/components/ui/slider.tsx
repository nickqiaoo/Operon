"use client"

// From https://ui.shadcn.com/r/styles/radix-rhea/slider.json, adapted to the
// project tokens: `bg-input` is undefined here (falls back to black), Tailwind's
// default shadows are disabled, and the track / range / thumb take class
// overrides so callers can draw a thick stepped track.

import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  trackClassName?: string
  rangeClassName?: string
  thumbClassName?: string
  /** Drawn over the track, under the thumb (e.g. step marks). */
  overlay?: React.ReactNode
}

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  trackClassName,
  rangeClassName,
  thumbClassName,
  overlay,
  "aria-label": ariaLabel,
  ...props
}: SliderProps) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "relative grow overflow-hidden rounded-full bg-foreground/10 data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1",
          trackClassName
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "absolute bg-brand-fill select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
            rangeClassName
          )}
        />
      </SliderPrimitive.Track>
      {overlay}
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          // The thumb carries role="slider", so the accessible name goes here.
          aria-label={ariaLabel}
          className={cn(
            "relative z-10 block size-4 shrink-0 cursor-grab rounded-full bg-white shadow-card ring-1 ring-border/60 transition-[box-shadow] duration-200 select-none hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden active:cursor-grabbing disabled:pointer-events-none disabled:opacity-50",
            thumbClassName
          )}
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
