import { useIntl } from "react-intl"
import { FileInput, Brain } from "lucide-react"

interface NodePaletteProps {
  onAddNode: (type: "input" | "ai") => void
}

/**
 * The editor's left rail. It used to hang off the bottom of the workflow list
 * (hence the top border); now it owns the rail, so it starts at the top.
 */
export function NodePalette({ onAddNode }: NodePaletteProps) {
  const intl = useIntl()

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 pb-2">
        <span className="heading-section">
          {intl.formatMessage({ id: "canvas.palette.title", defaultMessage: "Add node" })}
        </span>
      </div>
      <div className="space-y-1 px-3">
        <button
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          onClick={() => onAddNode("input")}
        >
          <FileInput className="h-4 w-4" />
          <span>{intl.formatMessage({ id: "canvas.palette.inputNode", defaultMessage: "Input node" })}</span>
        </button>
        <button
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          onClick={() => onAddNode("ai")}
        >
          <Brain className="h-4 w-4" />
          <span>{intl.formatMessage({ id: "canvas.palette.aiNode", defaultMessage: "AI node" })}</span>
        </button>
      </div>
    </div>
  )
}
