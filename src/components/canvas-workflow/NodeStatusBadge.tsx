import { CheckCircle2, Circle, Loader2, AlertCircle, MinusCircle, Clock } from "lucide-react"

export function NodeStatusBadge({ status }: { status?: string }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-3 w-3 text-status-ok shrink-0" />
    case "running":
      return <Loader2 className="h-3 w-3 text-status-info animate-spin shrink-0" />
    case "waiting":
      return <Clock className="h-3 w-3 text-status-warn shrink-0" />
    case "error":
      return <AlertCircle className="h-3 w-3 text-status-error shrink-0" />
    case "skipped":
      return <MinusCircle className="h-3 w-3 text-muted-foreground/50 shrink-0" />
    case "pending":
      return <Circle className="h-3 w-3 text-muted-foreground/40 shrink-0" />
    default:
      return null
  }
}
