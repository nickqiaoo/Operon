import { useEffect, useState } from "react"
import { FormattedMessage } from "react-intl"
import { Bot, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useChannelStore } from "@/stores/channel-store"
import { AgentManageDialog } from "@/components/channel/AgentManageDialog"
import { api } from "@/lib/api"

export function AgentSettings() {
  const agents = useChannelStore((s) => s.agents)
  const loadAgents = useChannelStore((s) => s.loadAgents)
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<{ id: string; label: string }[]>([])

  useEffect(() => {
    void loadAgents()
    void api
      .getProviders()
      .then((list) => setProviders(list.map((p) => ({ id: p.id, label: p.label }))))
      .catch(() => setProviders([]))
  }, [loadAgents])

  const previewNames = agents.slice(0, 3).map((a) => a.name).join(", ")
  const hasMore = agents.length > 3

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold mb-1"><FormattedMessage id="settings.agents.title" defaultMessage="Agents" /></h2>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="settings.agents.desc"
            defaultMessage="Agents are the AI personas IM bots embody in <code>mate</code> mode. Create and edit them here without having to open a channel."
            values={{ code: (chunks) => <span className="font-mono">{chunks}</span> }}
          />
        </p>
      </div>

      <div className="flex items-center justify-between rounded-xl border border-border/40 px-4 py-3 hover:bg-muted/20 transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-tint/15 shrink-0">
            <Bot className="w-4 h-4 text-tint" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">
              <FormattedMessage id="channel.agentCount" defaultMessage="{count, plural, one {# agent} other {# agents}}" values={{ count: agents.length }} />
            </div>
            <div className="text-xs text-muted-foreground/60 truncate">
              {agents.length === 0
                ? <FormattedMessage id="settings.agents.empty" defaultMessage="No agents yet — create one to use in mate mode." />
                : `${previewNames}${hasMore ? ", …" : ""}`}
            </div>
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setOpen(true)}
          className="h-8 gap-1.5 shrink-0"
        >
          <Settings2 className="h-3.5 w-3.5" />
          <FormattedMessage id="settings.agents.manage" defaultMessage="Manage" />
        </Button>
      </div>

      {open && (
        <AgentManageDialog
          open
          onClose={() => setOpen(false)}
          providers={providers}
        />
      )}
    </div>
  )
}
