import { App as CapacitorApp } from '@capacitor/app'
import { useEffect } from 'react'
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'
import { clearRouteProbe, clientRouteStatus, saveDirectAddress } from './remote-route'

/**
 * This device's direct route to a machine over Tailscale (remote-route.ts):
 * the address the machine shares over the sealed channel, and which way
 * requests go now. Web target only (the phone app and the browser client).
 */
export const remoteRouteKeys = {
  all: ['remote-route'] as const,
  info: (nodeId: string) => ['remote-route', nodeId, 'info'] as const,
  status: (nodeId: string) => ['remote-route', nodeId, 'status'] as const,
}

/** Asks the selected machine where it can be reached directly, and keeps the answer for secure-fetch. */
export const directInfoQuery = (nodeId: string) => queryOptions({
  queryKey: remoteRouteKeys.info(nodeId),
  queryFn: async () => {
    const info = await api.directInfo()
    saveDirectAddress(nodeId, info.address)
    return info
  },
  staleTime: 5 * 60_000,
  // A machine on a build without direct connections answers 404: keep Broker.
  retry: false,
})

/** Keeps the selected machine's direct address current: it changes when Tailscale or the setting does. */
export function useDirectInfoSync(nodeId: string | null) {
  const client = useQueryClient()
  useEffect(() => {
    if (!nodeId || !__APP_NATIVE__) return
    let active = true
    const listener = CapacitorApp.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive || !active) return
      clearRouteProbe(nodeId)
      const query = clientRouteStatusQuery(nodeId)
      await client.cancelQueries({ queryKey: query.queryKey })
      if (active) await client.fetchQuery({ ...query, staleTime: 0 })
    })
    return () => {
      active = false
      void listener.then((handle) => handle.remove())
    }
  }, [client, nodeId])
  return useQuery({ ...directInfoQuery(nodeId ?? ''), enabled: !!nodeId, refetchInterval: 10 * 60_000 })
}

/** Which way requests to `nodeId` go, checking the direct address first. */
export const clientRouteStatusQuery = (nodeId: string) => queryOptions({
  queryKey: remoteRouteKeys.status(nodeId),
  queryFn: () => clientRouteStatus(window.fetch.bind(window), nodeId, true),
  staleTime: 5_000,
})

export function useClientRouteStatus(nodeId: string | null) {
  return useQuery({ ...clientRouteStatusQuery(nodeId ?? ''), enabled: !!nodeId, refetchInterval: 15_000 })
}
