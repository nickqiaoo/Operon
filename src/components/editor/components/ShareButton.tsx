import { useState } from "react"
import { useIntl } from "react-intl"
import { Share2Icon } from "lucide-react"
import { MessageAction } from "@/components/ai-elements/message"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LinearIcon } from "@/components/icons/LinearIcon"
import { LinearShareDialog } from "./LinearShareDialog"

interface ShareButtonProps {
  text: string
}

export function ShareButton({ text }: ShareButtonProps) {
  const intl = useIntl()
  const [linearOpen, setLinearOpen] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <MessageAction label={intl.formatMessage({ id: "editor.action.share", defaultMessage: "Share" })}>
            <Share2Icon className="size-3" />
          </MessageAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="border-border/50 min-w-28">
          <DropdownMenuItem
            onSelect={() => setLinearOpen(true)}
            className="text-xs gap-2"
          >
            <LinearIcon className="h-3.5 w-3.5" />
            Linear
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LinearShareDialog
        open={linearOpen}
        onOpenChange={setLinearOpen}
        messageText={text}
      />
    </>
  )
}
