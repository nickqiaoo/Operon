import * as React from "react"
import { Group, Panel, Separator } from "react-resizable-panels"
import { cn } from "@/lib/utils"

type ResizablePanelGroupProps = Omit<React.ComponentProps<typeof Group>, 'orientation'> & {
  direction?: 'horizontal' | 'vertical'
}

const ResizablePanelGroup = ({
  className,
  direction = 'horizontal',
  ...props
}: ResizablePanelGroupProps) => (
  <Group
    orientation={direction}
    className={cn(
      "flex h-full w-full",
      direction === 'vertical' && "flex-col",
      className
    )}
    {...props}
  />
)

const ResizablePanel = Panel

const ResizableHandle = ({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) => (
  <Separator
    className={cn(
      "relative flex items-center justify-center bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
      "data-[orientation=horizontal]:w-3 data-[orientation=horizontal]:cursor-col-resize data-[orientation=horizontal]:after:absolute data-[orientation=horizontal]:after:left-1/2 data-[orientation=horizontal]:after:h-full data-[orientation=horizontal]:after:w-px data-[orientation=horizontal]:after:-translate-x-1/2 data-[orientation=horizontal]:after:bg-border",
      "data-[orientation=vertical]:h-3 data-[orientation=vertical]:cursor-row-resize data-[orientation=vertical]:after:absolute data-[orientation=vertical]:after:top-1/2 data-[orientation=vertical]:after:w-full data-[orientation=vertical]:after:h-px data-[orientation=vertical]:after:-translate-y-1/2 data-[orientation=vertical]:after:bg-border",
      "hover:after:bg-tint hover:after:opacity-60",
      className
    )}
    {...props}
  />
)

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
