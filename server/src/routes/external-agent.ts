import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { listExternalAgents, subscribeExternalAgents } from '../services/external-agent.js'

export function externalAgentRoutes() {
  const router = new Hono()
  router.get('/', (c) => c.json({ agents: listExternalAgents() }))
  router.get('/feed', (c) => streamSSE(c, async (stream) => {
    let finish!: () => void
    const closed = new Promise<void>((resolve) => { finish = resolve })
    // Subscribe before the initial snapshot; there is no async gap in which a
    // newly created child can be missed. Snapshot frames never auto-open tabs.
    const off = subscribeExternalAgents((event) => {
      void stream.writeSSE({ data: JSON.stringify(event) }).catch(finish)
    })
    stream.onAbort(finish)
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: 'sync', agents: listExternalAgents() }) })
      await closed
    } finally { off() }
  }))
  return router
}
