import { create } from "zustand"

/**
 * Provider feature flags, cached by provider id as chat panels load them.
 *
 * `useModelManagement` already fetches a provider's config for every open chat;
 * this keeps the capability bits from that response somewhere surfaces outside a
 * chat panel can reach — the right panel's new-tab menu needs to know whether
 * the active conversation's provider can fork before offering a side chat.
 *
 * Only providers the app has actually loaded appear here, which is enough for
 * gating: a capability question is always asked about a conversation that is
 * open, and opening one loads its provider.
 */
export interface ProviderCapabilities {
  /** Provider can branch a session off another — what a side chat is built on. */
  sideChat: boolean
}

interface ProviderCapabilityState {
  byProvider: Record<string, ProviderCapabilities>
  setCapabilities: (providerId: string, capabilities: ProviderCapabilities) => void
}

export const useProviderCapabilityStore = create<ProviderCapabilityState>()((set) => ({
  byProvider: {},
  setCapabilities: (providerId, capabilities) =>
    set((state) => {
      const current = state.byProvider[providerId]
      if (current?.sideChat === capabilities.sideChat) return {}
      return { byProvider: { ...state.byProvider, [providerId]: capabilities } }
    }),
}))

export const providerSupportsSideChat = (providerId: string | undefined): boolean =>
  providerId != null &&
  useProviderCapabilityStore.getState().byProvider[providerId]?.sideChat === true
