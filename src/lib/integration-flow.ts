import { api } from '@/lib/api'
import { openExternalUrl } from '@/lib/open-external'
import type { IntegrationAppStatus, IntegrationFlowKind } from '@/types/integrations'

// The browser round-trip an install / link flow makes (docs/linear-github/design.md §4):
// the server hands us the authorize URL, the OS browser does the platform
// step and lands on the server's loopback, and we learn the outcome by
// polling the status until the flow leaves "pending".

const POLL_MS = 2000
const TIMEOUT_MS = 5 * 60 * 1000

export async function runIntegrationFlow(
  kind: IntegrationFlowKind,
  start: () => Promise<{ authorizeUrl?: string; error?: string; code?: string }>,
): Promise<IntegrationAppStatus> {
  const res = await start()
  if (!res.authorizeUrl) {
    throw new Error(res.error ?? 'Could not start authorization')
  }
  openExternalUrl(res.authorizeUrl)
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const status = await api.integrationAppStatus()
    const flow = status.flows[kind]
    if (!flow || flow.status === 'pending') continue
    if (flow.status === 'error') throw new Error(flow.message ?? 'Authorization failed')
    return status
  }
  throw new Error('Authorization timed out. Please try again.')
}
