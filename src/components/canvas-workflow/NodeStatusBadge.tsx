import { CheckCircle2, Circle, Loader2, AlertCircle } from "lucide-react"

export function NodeStatusBadge({ status }: { status?: string }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
    case "running":
      return <Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />
    case "error":
      return <AlertCircle className="h-3 w-3 text-red-500 shrink-0" />
    case "pending":
      return <Circle className="h-3 w-3 text-muted-foreground/40 shrink-0" />
    default:
      return null
  }
}
