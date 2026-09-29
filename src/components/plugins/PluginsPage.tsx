import { FormattedMessage } from "react-intl"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PluginsSettings } from "@/components/settings/PluginsSettings"

interface PluginsPageProps {
  onBack: () => void
}

/** Full-screen Plugins page, opened from the sidebar (and from plugin deep links). */
export function PluginsPage({ onBack }: PluginsPageProps) {
  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      <div className="h-10 drag-region shrink-0 bg-background" />

      <div className="h-14 shrink-0 border-b border-border/40 flex items-center px-6 bg-background/80 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 gap-1.5 rounded-lg px-2.5 text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-sm font-medium">
              <FormattedMessage id="common.back" defaultMessage="Back" />
            </span>
          </Button>
          <div className="h-4 w-px bg-border/60" />
          <span className="text-sm font-semibold tracking-tight">
            <FormattedMessage id="plugins.title" defaultMessage="Plugins" />
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto code-scrollbar scroll-fade-y">
        <div className="mx-auto max-w-4xl px-8 py-7">
          <PluginsSettings />
        </div>
      </div>
    </div>
  )
}
