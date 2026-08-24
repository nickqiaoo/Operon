"use client"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { OpenInIdeApp } from "@/types/open-in-ide"
import { ChevronDownIcon, Copy, FolderOpen } from "lucide-react"
import { type ComponentProps, useCallback } from "react"

import vscodeSvg from "@/assets/ide/vscode.svg"

type OpenInIdeMenuProps = Omit<ComponentProps<typeof DropdownMenu>, "children"> & {
  targetPath: string | null
  label?: string
  className?: string
}

const ideIcons: Partial<Record<OpenInIdeApp | "finder", string>> = {
  vscode: vscodeSvg,
}

try {
  const modules = import.meta.glob("@/assets/ide/*.svg", { eager: true, import: "default" }) as Record<string, string>
  for (const [path, url] of Object.entries(modules)) {
    const name = path.split("/").pop()?.replace(".svg", "") as OpenInIdeApp
    if (name) ideIcons[name] = url
  }
} catch { /* ignore */ }

const ideItems: { id: OpenInIdeApp; label: string }[] = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "antigravity", label: "Antigravity" },
  { id: "xcode", label: "Xcode" },
  { id: "zed", label: "Zed" },
  { id: "finder", label: "Finder" },
]

export const OpenInIdeMenu = ({
  targetPath,
  label = "Open",
  className,
  ...props
}: OpenInIdeMenuProps) => {
  const isEnabled = Boolean(targetPath && window.electronAPI?.openInIde)

  const handleOpen = useCallback(
    async (app: OpenInIdeApp) => {
      if (!targetPath || !window.electronAPI?.openInIde) return
      const result = await window.electronAPI.openInIde({ app, targetPath })
      if (!result.success) {
        console.error("[OpenInIde] Failed:", result.error)
      }
    },
    [targetPath]
  )

  const handleCopyPath = useCallback(async () => {
    if (!targetPath) return
    try {
      await navigator.clipboard.writeText(targetPath)
    } catch (error) {
      console.error("[OpenInIde] Copy failed:", error)
    }
  }, [targetPath])

  return (
    <DropdownMenu {...props}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!isEnabled}
          className={cn("no-drag text-muted-foreground hover:text-foreground", className)}
        >
          <span>{label}</span>
          <ChevronDownIcon className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Open in
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ideItems.map((item) => (
          <DropdownMenuItem key={item.id} onClick={() => handleOpen(item.id)}>
            {ideIcons[item.id] ? (
              <img src={ideIcons[item.id]} alt="" className="size-4 shrink-0" />
            ) : item.id === "finder" ? (
              <FolderOpen className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            {item.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCopyPath}>
          <Copy className="size-4 shrink-0" />
          Copy Path
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
