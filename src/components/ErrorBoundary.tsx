import { Component, type ReactNode, type ErrorInfo } from "react"
import { trackError } from "@/lib/analytics"
import { isChunkLoadError, reloadForStaleChunk } from "@/lib/stale-chunk-reload"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // React.lazy rethrows a failed chunk import here; vite:preloadError doesn't
    // cover imports made inside dependencies.
    if (isChunkLoadError(error) && reloadForStaleChunk()) return
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack)
    trackError(error, { component_stack: info.componentStack ?? undefined })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-background text-foreground">
          <div className="flex flex-col items-center gap-4 max-w-md text-center p-8">
            <p className="text-lg font-medium">Something went wrong</p>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message ?? "An unexpected error occurred"}
            </p>
            <button
              className="text-sm px-4 py-2 rounded-lg bg-muted hover:bg-accent-hover transition-colors"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
