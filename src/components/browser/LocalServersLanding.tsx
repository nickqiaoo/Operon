import { useCallback, useEffect, useMemo, useState } from "react"
import { Globe, RefreshCw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  getServerHistory,
  removeServerHistory,
  subscribeServerHistory,
  type LocalServerEntry,
} from "./serverHistory"

interface LocalServersLandingProps {
  /** Open the chosen server's URL in this browser tab's webview. */
  onOpen: (url: string) => void
}

type Filter = "online" | "all"

interface ServerRow extends LocalServerEntry {
  online: boolean
}

/**
 * The in-app browser's empty/landing state — codex-style. Lists the local
 * addresses the user has opened before (tracked in `serverHistory`) so they
 * can be reopened with one click. We never scan listening ports; the status
 * dot reflects a liveness probe of each remembered port.
 */
export function LocalServersLanding({ onOpen }: LocalServersLandingProps) {
  const canProbe =
    typeof window !== "undefined" && Boolean(window.electronAPI?.probeLocalServers)
  const [history, setHistory] = useState<LocalServerEntry[]>(() => getServerHistory())
  const [online, setOnline] = useState<Record<number, boolean>>({})
  const [filter, setFilter] = useState<Filter>("all")
  const [loading, setLoading] = useState(false)

  // Live-update the list as the user opens new servers in any tab.
  useEffect(
    () => subscribeServerHistory(() => setHistory(getServerHistory())),
    []
  )

  const refresh = useCallback(() => {
    const entries = getServerHistory()
    setHistory(entries)
    if (!canProbe || entries.length === 0) {
      setOnline({})
      return
    }
    setLoading(true)
    window
      .electronAPI!.probeLocalServers(entries.map((e) => e.port))
      .then((results) => {
        const map: Record<number, boolean> = {}
        for (const r of results) map[r.port] = r.online
        setOnline(map)
      })
      .catch(() => setOnline({}))
      .finally(() => setLoading(false))
  }, [canProbe])

  useEffect(() => {
    refresh()
  }, [refresh])

  const rows = useMemo<ServerRow[]>(
    () => history.map((e) => ({ ...e, online: online[e.port] ?? false })),
    [history, online]
  )
  const visible = useMemo(
    () => (filter === "online" ? rows.filter((r) => r.online) : rows),
    [rows, filter]
  )

  const handleRemove = (url: string) => {
    removeServerHistory(url)
    setHistory(getServerHistory())
  }

  return (
    <div className="absolute inset-0 overflow-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-[460px] flex-col items-center gap-7 px-6 py-12">
        <div className="flex flex-col items-center gap-2 text-center">
          <Globe className="h-7 w-7 text-muted-foreground" />
          <div className="text-base font-medium text-foreground">Start browsing</div>
          <div className="text-sm text-muted-foreground">Enter a URL to open a page</div>
        </div>

        <div className="w-full">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-normal text-muted-foreground">Local</h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setFilter((f) => (f === "online" ? "all" : "online"))}
                className="rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                {filter === "online" ? "Online" : "All"}
              </button>
              <button
                type="button"
                onClick={refresh}
                aria-label="Refresh local servers"
                title="Refresh"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-xl border border-border/40 bg-muted/10 px-4 py-8 text-center text-sm text-muted-foreground">
              No servers yet — open a localhost URL and it'll show up here.
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-border/40 bg-muted/10 py-8 text-center text-sm text-muted-foreground">
              No local online servers
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {visible.map((server) => (
                <div
                  key={`${server.host}:${server.port}`}
                  className="group flex items-center gap-3 rounded-xl border border-border/40 bg-muted/10 p-2.5 transition-colors hover:border-border/60 hover:bg-muted/40"
                >
                  <button
                    type="button"
                    onClick={() => onOpen(server.url)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    {/* Mini-browser thumbnail placeholder (no screenshot yet). */}
                    <div className="flex h-12 w-16 shrink-0 flex-col gap-1 rounded-md border border-border/40 bg-background p-1.5">
                      <div className="flex gap-0.5">
                        <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                        <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                        <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                      </div>
                      <div className="truncate text-[7px] font-medium text-muted-foreground">
                        {server.title}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {server.title}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {`${server.host}:${server.port}`}
                      </div>
                    </div>
                  </button>
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      server.online ? "bg-green-500" : "bg-muted-foreground/40"
                    )}
                    title={server.online ? "Online" : "Offline"}
                  />
                  <button
                    type="button"
                    onClick={() => handleRemove(server.url)}
                    aria-label={`Remove ${server.host}:${server.port}`}
                    title="Remove"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
