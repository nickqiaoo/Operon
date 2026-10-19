import { FormattedMessage } from 'react-intl'
import { LayoutDashboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEditorStore } from '@/stores/editor-store'
import { parseCanvasChatId } from '@/lib/canvas-utils'

interface CanvasChatBannerProps {
  chatId: string
}

export function CanvasChatBanner({ chatId }: CanvasChatBannerProps) {
  const canvasInfo = parseCanvasChatId(chatId)
  const requestOpenCanvas = useEditorStore((s) => s.requestOpenCanvas)

  if (!canvasInfo) return null

  return (
    <div className="mx-4 mt-2 space-y-1">
      <div className="px-3 py-2 rounded-lg bg-brand-muted border border-brand/10 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LayoutDashboard className="h-3.5 w-3.5 text-brand" />
          <span><FormattedMessage id="editor.canvas.fromNode" defaultMessage="This conversation is from a workflow node." /></span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-brand hover:text-brand hover:bg-brand-muted"
          onClick={() => requestOpenCanvas({
            workflowId: 0,
            runId: canvasInfo.runId,
            nodeId: canvasInfo.nodeId,
          })}
        >
          <FormattedMessage id="editor.canvas.viewInWorkflow" defaultMessage="View in Workflow" />
        </Button>
      </div>
      <div className="text-xs text-muted-foreground/60 px-3">
        <FormattedMessage id="editor.canvas.continueHint" defaultMessage="You can continue the conversation here. Changes will not affect the workflow execution." />
      </div>
    </div>
  )
}
