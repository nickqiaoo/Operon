import { CheckCircle2, AlertCircle, Loader2, Clock, ChevronDown } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { CanvasWorkflowRun } from "@/types/canvas-workflow"
import { cn } from "@/lib/utils"

interface RunResultPanelProps {
  run: CanvasWorkflowRun | null
  runs: CanvasWorkflowRun[]
  selectedRunId: number | null
  onSelectRun: (runId: number) => void
}

export function RunResultPanel({ run, runs, selectedRunId, onSelectRun }: RunResultPanelProps) {
  return (
    <div className="h-full flex flex-col">
      {/* Run Selector */}
      {runs.length > 0 && (
        <div className="border-b border-border/50 px-4 py-2.5 flex items-center justify-between">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 text-sm hover:bg-muted/50 rounded-md px-2 py-1 -ml-2 transition-colors">
                {run && <RunStatusIcon status={run.status} size="sm" />}
                <span className="text-foreground/80">
                  {run ? formatRelativeTime(run.startedAt) : "Select a run"}
                </span>
                <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-[260px] rounded-xl border border-border/50 bg-background/95 p-1 shadow-float backdrop-blur-sm"
            >
              {runs.map((r) => (
                <DropdownMenuItem
                  key={r.id}
                  onClick={() => onSelectRun(r.id)}
                  className={cn(
                    "flex items-center gap-2 text-xs cursor-pointer",
                    selectedRunId === r.id && "bg-tint-muted text-foreground font-medium"
                  )}
                >
                  <RunStatusIcon status={r.status} size="sm" />
                  <span className="flex-1">{formatRelativeTime(r.startedAt)}</span>
                  <span className="text-[10px] text-muted-foreground/50">
                    {r.finishedAt ? formatDuration(r.startedAt, r.finishedAt) : "..."}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {run?.startedAt && (
            <span className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(run.startedAt, run.finishedAt)}
            </span>
          )}
        </div>
      )}

      {/* Run Details */}
      {run ? (
        <>
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-3">
              {/* Node Results */}
              {run.nodeResults.map((result) => (
                <div
                  key={result.nodeId}
                  className="rounded-lg border border-border/40 bg-muted/10 overflow-hidden transition-colors hover:border-border/60 hover:bg-muted/20"
                >
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-muted/20">
                    <NodeResultStatusIcon status={result.status} />
                    <span className="text-xs font-medium">{result.nodeId}</span>
                    {result.startedAt && result.finishedAt && (
                      <span className="text-[10px] text-muted-foreground/50 ml-auto">
                        {formatDuration(result.startedAt, result.finishedAt)}
                      </span>
                    )}
                  </div>
                  {result.output && (
                    <div className="px-3 py-2 text-xs text-foreground/80 whitespace-pre-wrap max-h-[200px] overflow-y-auto code-scrollbar">
                      {result.output.length > 500 ? result.output.slice(0, 500) + "..." : result.output}
                    </div>
                  )}
                  {result.error && (
                    <div className="px-3 py-2 text-xs text-red-500">
                      {result.error}
                    </div>
                  )}
                </div>
              ))}

              {/* Final Outputs */}
              {run.outputs && Object.keys(run.outputs).length > 0 && (
                <div className="pt-3 border-t border-border/40">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
                    Final Outputs
                  </span>
                  {Object.entries(run.outputs).map(([key, value]) => (
                    <div key={key} className="mt-2 rounded-lg border border-border/40 bg-muted/10 overflow-hidden">
                      <div className="px-3 py-1.5 border-b border-border/40 bg-muted/20">
                        <span className="text-xs font-medium">{key}</span>
                      </div>
                      <div className="px-3 py-2 text-xs text-foreground/80 whitespace-pre-wrap max-h-[300px] overflow-y-auto code-scrollbar">
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {run.error && (
                <div className="rounded-lg border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20 px-3 py-2">
                  <span className="text-xs text-red-600 dark:text-red-400">{run.error}</span>
                </div>
              )}
            </div>
          </ScrollArea>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground/60 p-6">
          {runs.length > 0 ? "Select a run to view details" : "Execute a workflow to see results"}
        </div>
      )}
    </div>
  )
}

function RunStatusIcon({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  const cls = size === "sm" ? "h-3 w-3" : "h-4 w-4"
  switch (status) {
    case "success":
      return <CheckCircle2 className={`${cls} text-green-500`} />
    case "running":
      return <Loader2 className={`${cls} text-blue-500 animate-spin`} />
    case "error":
      return <AlertCircle className={`${cls} text-red-500`} />
    default:
      return null
  }
}

function NodeResultStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-3 w-3 text-green-500" />
    case "running":
      return <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />
    case "error":
      return <AlertCircle className="h-3 w-3 text-red-500" />
    default:
      return <div className="h-3 w-3 rounded-full border border-muted-foreground/30" />
  }
}

function formatDuration(startMs: number, endMs?: number): string {
  const end = endMs || Date.now()
  const diff = end - startMs
  if (diff < 1000) return `${diff}ms`
  if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`
  return `${Math.floor(diff / 60000)}m ${Math.floor((diff % 60000) / 1000)}s`
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return "Just now"
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
